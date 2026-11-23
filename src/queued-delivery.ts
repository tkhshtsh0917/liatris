import {
	type BatchDelivery,
	maxBatchBytes,
	maxBatchEvents,
	type ReceiptStatus,
	readBatchReceipts,
} from "./batch.ts";
import type { Delivery } from "./collector.ts";
import { HttpDeliveryError } from "./http-delivery.ts";
import {
	deliveryPriority,
	openOutbox,
	type QueuedEvent,
	updateOutbox,
} from "./outbox-storage.ts";
import type { Profile } from "./profile.ts";
import { type Envelope, maxRecordBytes } from "./records.ts";
import type { SessionStore } from "./session-store.ts";

type DropReason = "expired" | "capacity" | "rejected";
type Options = {
	profile: Pick<Profile, "tenant" | "application">;
	profileHash: string;
	onDrop?: (reason: DropReason) => void;
} & (
	| { send: Delivery; sendBatch?: never; parallelBatches?: never }
	| { sendBatch: BatchDelivery; send?: never; parallelBatches?: 1 | 2 }
);

type Lease = { generation: string; controller: AbortController };
type PendingWrite = {
	record: Envelope;
	signal: AbortSignal;
	resolve: () => void;
	reject: (error: unknown) => void;
};

const capacity = 512;
const protectedCapacity = 64;
const coalesceMs = 8;
const retentionMs = 24 * 60 * 60_000;
const requestTimeoutMs = 15_000;

/** Creates an opt-in IndexedDB queue for a single collection scope. */
export function createQueuedDelivery({
	profile,
	profileHash,
	send,
	sendBatch,
	parallelBatches = 1,
	onDrop,
}: Options) {
	if (parallelBatches !== 1 && parallelBatches !== 2)
		throw new RangeError("parallelBatches must be 1 or 2");

	const scope = JSON.stringify([profile.tenant, profile.application]);
	let database: Promise<IDBDatabase> | undefined;
	let channel: BroadcastChannel | undefined;
	let active: Lease | undefined;
	let withdrawnGeneration: string | undefined;
	let withdrawalTarget: { generation: string | undefined } | undefined;
	let pendingWithdrawal: string | undefined;
	let writeGroup: { lease: Lease; writes: PendingWrite[] } | undefined;
	const encoder = new TextEncoder();
	let coalesce: ReturnType<typeof setTimeout> | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let drain: Promise<void> | undefined;
	let wakeRequested = false;

	function open() {
		database ??= openOutbox().catch((error: unknown) => {
			database = undefined;
			throw error;
		});
		return database;
	}

	function stop() {
		active?.controller.abort();
		active = undefined;
		clearTimeout(retry);
		clearTimeout(coalesce);
		coalesce = undefined;
		window.removeEventListener("online", wake);
		document.removeEventListener("visibilitychange", wake);
	}

	function notify(reason: DropReason) {
		try {
			onDrop?.(reason);
		} catch {
			/* A diagnostic cannot change delivery state. */
		}
	}

	function schedule(at: number) {
		clearTimeout(retry);
		retry = setTimeout(wake, Math.max(0, at - Date.now()));
	}

	function byteLength(record: Envelope) {
		return encoder.encode(JSON.stringify(record)).length;
	}

	async function saveGroup(lease: Lease, writes: PendingWrite[]) {
		try {
			const result = await updateOutbox(
				await open(),
				scope,
				async (state, outbox) => {
					if (
						state?.generation !== lease.generation ||
						lease.controller.signal.aborted
					)
						return;

					const now = Date.now();
					const expired = await outbox.expire(now);
					let occupied = await outbox.count();
					const errors: (Error | undefined)[] = [];
					let clickReady = false;
					for (const { record, signal } of writes) {
						if (signal.aborted || lease.controller.signal.aborted) {
							errors.push(new Error("collection consent was withdrawn"));
							continue;
						}
						const priority = deliveryPriority(record);
						const limit = priority ? capacity - protectedCapacity : capacity;
						// Overwriting an existing ID can leave more room than the upper bound.
						if (occupied >= limit) occupied = await outbox.count();
						if (signal.aborted || lease.controller.signal.aborted) {
							errors.push(new Error("collection consent was withdrawn"));
							continue;
						}
						if (occupied >= limit) {
							errors.push(new RangeError("collection queue is full"));
							continue;
						}
						try {
							const encodedBytes = byteLength(record);
							if (encodedBytes > maxRecordBytes)
								throw new RangeError("collection record is too large");

							outbox.put({
								scope,
								record,
								encodedBytes,
								priority,
								expiresAt: now + retentionMs,
								nextAttempt: now,
								attempts: 0,
							});
						} catch (error) {
							errors.push(
								error instanceof Error
									? error
									: new Error("queue write failed"),
							);
							continue;
						}
						errors.push(undefined);
						if (record.payload.action_name === "click") clickReady = true;
						occupied++;
					}
					return { errors, expired, clickReady };
				},
			);
			if (!result) {
				if (active === lease) stop();
				throw new Error("collection consent was withdrawn");
			}

			for (let i = 0; i < result.expired; i++) notify("expired");
			for (const [index, error] of result.errors.entries()) {
				if (error) {
					if (error.message === "collection queue is full") notify("capacity");
					writes[index].reject(error);
				} else {
					writes[index].resolve();
				}
			}
			if (
				active === lease &&
				result.errors.some((error) => error === undefined)
			) {
				if (!sendBatch || drain || result.clickReady) wake();
				else coalesce ??= setTimeout(wake, coalesceMs);
			}
		} catch (error) {
			for (const write of writes) write.reject(error);
		}
	}

	function sizedBatch(entries: QueuedEvent[]) {
		let bytes = 2;
		let count = 0;
		for (const entry of entries) {
			const size =
				(entry.encodedBytes ?? byteLength(entry.record)) + Number(count > 0);
			if (count === maxBatchEvents || bytes + size > maxBatchBytes) break;
			bytes += size;
			count++;
		}
		return entries.slice(0, count);
	}

	async function dispatch(records: Envelope[], signal: AbortSignal) {
		if (sendBatch)
			return readBatchReceipts(await sendBatch(records, signal), records);
		if (!send) throw new TypeError("delivery is required");
		await send(records[0], signal);
		return [{ event_id: records[0].event_id, status: "accepted" as const }];
	}

	async function drainReady() {
		const lease = active;
		if (!lease) return;

		const next = await updateOutbox(
			await open(),
			scope,
			async (state, outbox) => {
				if (!state || state.generation !== lease.generation) return;
				const now = Date.now();
				const expired = await outbox.expire(now);
				const ready = await outbox.ready(
					profileHash,
					now,
					sendBatch ? parallelBatches * maxBatchEvents : 1,
				);
				const nextAttempt = ready.length
					? Infinity
					: await outbox.nextAttempt(profileHash, now);
				return { ready, expired, nextAttempt };
			},
		);
		if (active !== lease) return;
		if (!next) {
			stop();
			return;
		}

		for (let i = 0; i < next.expired; i++) notify("expired");
		if (!next.ready.length) {
			if (Number.isFinite(next.nextAttempt)) schedule(next.nextAttempt);
			return;
		}
		const first = sendBatch ? sizedBatch(next.ready) : next.ready;
		const groups = [first];
		if (parallelBatches === 2 && first.length < next.ready.length)
			groups.push(sizedBatch(next.ready.slice(first.length)));

		// Finish all requests in this selection before reading the outbox again.
		const settled = await Promise.allSettled(
			groups.map((entries) => deliverEntries(lease, entries)),
		);
		const failed = settled.find((result) => result.status === "rejected");
		if (failed) throw failed.reason;
	}

	async function deliverEntries(lease: Lease, entries: QueuedEvent[]) {
		if (lease.controller.signal.aborted) return;
		const receipts = new Map<string, ReceiptStatus>();
		let retryAfter = 0;
		let fallback: ReceiptStatus = "retry";
		try {
			const acknowledged = await dispatch(
				entries.map(({ record }) => record),
				AbortSignal.any([
					lease.controller.signal,
					AbortSignal.timeout(requestTimeoutMs),
				]),
			);
			for (const receipt of acknowledged)
				receipts.set(receipt.event_id, receipt.status);
		} catch (error) {
			if (error instanceof HttpDeliveryError) {
				retryAfter = error.retryAfterMs;
				if (!error.retryable) fallback = "rejected";
			}
		}
		if (lease.controller.signal.aborted) return;

		const rejected = await updateOutbox(
			await open(),
			scope,
			async (state, outbox) => {
				if (!state || state.generation !== lease.generation) return;
				let count = 0;
				for (const entry of entries) {
					const id = entry.record.event_id;
					const status = receipts.get(id) ?? fallback;
					if (status !== "retry") {
						if (status === "rejected" && (await outbox.has(id))) count++;
						outbox.remove(id);
						continue;
					}

					const current = await outbox.get(id);
					if (current?.attempts === entry.attempts) {
						const delay = Math.min(
							300_000,
							1000 * 2 ** Math.min(entry.attempts, 9),
						);
						outbox.put({
							...current,
							attempts: entry.attempts + 1,
							nextAttempt:
								Date.now() +
								Math.max(retryAfter, delay * (0.5 + Math.random() * 0.5)),
						});
					}
				}
				return count;
			},
		);
		for (let i = 0; i < (rejected ?? 0); i++) notify("rejected");
		if (active === lease) {
			if (rejected !== undefined) wakeRequested = true;
			else stop();
		}
	}

	function wake() {
		if (!active) return;
		clearTimeout(retry);
		clearTimeout(coalesce);
		coalesce = undefined;
		if (drain) {
			wakeRequested = true;
			return;
		}
		drain = drainReady()
			.catch(() => {
				if (active) schedule(Date.now() + 5000);
			})
			.finally(() => {
				drain = undefined;
				if (wakeRequested) {
					wakeRequested = false;
					wake();
				}
			});
	}

	function watchRevocation() {
		channel ??= new BroadcastChannel("liatris-consent");
		channel.onmessage = (
			message: MessageEvent<{ scope?: string; generation?: string }>,
		) => {
			if (
				active &&
				message.data?.scope === scope &&
				message.data.generation === active.generation
			) {
				withdrawnGeneration = active.generation;
				stop();
			}
		};
	}

	return {
		suspend: stop,

		resume() {
			if (!active) return;
			window.addEventListener("online", wake);
			document.addEventListener("visibilitychange", wake);
			wake();
		},

		/** Opens this tab's consent lease before delivery starts. */
		async grant() {
			if (active) return active.controller.signal;
			watchRevocation();
			const state = await updateOutbox(
				await open(),
				scope,
				async (state, outbox) => {
					if (state) {
						if (
							!state.cleanupPending &&
							state.generation !== withdrawnGeneration
						)
							return state;

						// The notice can arrive even if IndexedDB still has the old grant.
						await outbox.removeAll();
					}

					const created = { generation: crypto.randomUUID() };
					outbox.setConsent(created);
					return created;
				},
			);
			active = {
				generation: state.generation,
				controller: new AbortController(),
			};
			// Check persisted consent after registering for notifications.
			await updateOutbox(await open(), scope, (current) => {
				if (active && current?.generation !== active.generation) stop();
			});
			if (!active)
				throw new Error("collection consent was withdrawn during setup");
			withdrawnGeneration = undefined;
			return active.controller.signal;
		},

		/** Aborts this tab and deletes session and queued data for every tab in the scope. */
		async revoke() {
			stop();
			watchRevocation();
			const db = await open();
			if (pendingWithdrawal === undefined) {
				// Commit the new generation before deletion so a failed purge cannot
				// make the previous session and its events eligible for replay.
				const withdrawal = await updateOutbox(db, scope, (state, outbox) => {
					// A retry after a failed write still targets the original grant.
					if (
						withdrawalTarget &&
						withdrawalTarget.generation !== state?.generation
					)
						return;
					if (state?.cleanupPending) return state.generation;

					withdrawalTarget = { generation: state?.generation };
					// Stop other tabs even if the following IndexedDB write fails.
					if (state)
						channel?.postMessage({ scope, generation: state.generation });

					const generation = crypto.randomUUID();
					outbox.setConsent({ generation, cleanupPending: true });
					return generation;
				});
				pendingWithdrawal = withdrawal;
			}

			const generation = pendingWithdrawal;
			if (generation !== undefined) {
				await updateOutbox(db, scope, async (state, outbox) => {
					// Another tab may already have cleaned up before enabling collection.
					if (!state?.cleanupPending || state.generation !== generation) return;

					await outbox.removeAll();
					outbox.setConsent({ generation });
				});
			}
			pendingWithdrawal = undefined;
			withdrawalTarget = undefined;
		},

		/** Shares the session transaction with the same persisted consent generation. */
		async openSessionStore(): Promise<SessionStore> {
			await open();
			return {
				async update(_key, select) {
					const lease = active;
					if (!lease) throw new Error("collection consent is inactive");
					const ownership = await updateOutbox(
						await open(),
						scope,
						(state, outbox) => {
							if (
								!state ||
								state.generation !== lease.generation ||
								lease.controller.signal.aborted
							)
								return;
							const session = select(state.session);
							outbox.setConsent({ generation: state.generation, session });
							return { session };
						},
					);
					if (!ownership) {
						if (active === lease) stop();
						throw new Error("collection consent was withdrawn");
					}
					return ownership.session;
				},
			};
		},

		/** Returns after committing the envelope. A receiver acknowledgement removes it later. */
		async enqueue(record: Envelope, signal: AbortSignal) {
			const lease = active;
			if (!lease) throw new Error("collection consent is inactive");
			if (signal.aborted) throw new Error("collection consent was withdrawn");

			const { promise, resolve, reject } = Promise.withResolvers<void>();
			if (
				writeGroup?.lease !== lease ||
				writeGroup.writes.length === maxBatchEvents
			) {
				const group = { lease, writes: [] as PendingWrite[] };
				writeGroup = group;
				queueMicrotask(() => {
					if (writeGroup === group) writeGroup = undefined;
					void saveGroup(lease, group.writes);
				});
			}
			writeGroup.writes.push({ record, signal, resolve, reject });
			return promise;
		},

		async close() {
			stop();
			channel?.close();
			channel = undefined;
			const db = await database;
			database = undefined;
			db?.close();
		},
	};
}

export type QueuedDelivery = ReturnType<typeof createQueuedDelivery>;
