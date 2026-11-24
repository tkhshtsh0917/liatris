import {
	type BatchDelivery,
	maxBatchBytes,
	maxBatchEvents,
	type ReceiptStatus,
	readBatchReceipts,
} from "./batch.ts";
import type { Delivery } from "./collector.ts";
import { readObject } from "./fields.ts";
import { HttpDeliveryError } from "./http-delivery.ts";
import {
	type ConsentOrder,
	type ConsentState,
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

type Generation = { generation: string; order: ConsentOrder };
type Lease = Generation & { controller: AbortController };

function consentOrder(state: ConsentState): ConsentOrder {
	return state.order ?? { lineage: state.generation, revision: 0 };
}

function nextGeneration(
	generation: string,
	previous: ConsentState | undefined,
): Generation {
	if (!previous)
		return { generation, order: { lineage: generation, revision: 0 } };

	const { lineage, revision } = consentOrder(previous);
	return { generation, order: { lineage, revision: revision + 1 } };
}

/** Identifies one queued withdrawal for a later retry in the same collection scope. */
export type WithdrawalRetry = Readonly<{
	scope: string;
	generation: string | null;
	marker: string;
}>;

/** A failed queued withdrawal with a serializable retry target, when known. */
export class ConsentWithdrawalError extends Error {
	readonly retry?: WithdrawalRetry;

	constructor(cause: unknown, retry?: WithdrawalRetry) {
		super("Could not complete withdrawal", { cause });
		this.name = "ConsentWithdrawalError";
		this.retry = retry;
	}
}

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
	let closing: Promise<void> | undefined;
	let channel: BroadcastChannel | undefined;
	let active: Lease | undefined;
	let openingGrant: AbortController | undefined;
	let granting: Promise<AbortSignal> | undefined;
	let verifiedOrder: ConsentOrder | undefined;
	const withdrawals = new Map<string, Set<string>>();
	let withdrawing: { done: Promise<void>; retry: boolean } | undefined;
	let failedWithdrawal: { target?: WithdrawalRetry } | undefined;
	let writeGroup: { lease: Lease; writes: PendingWrite[] } | undefined;
	const encoder = new TextEncoder();
	let coalesce: ReturnType<typeof setTimeout> | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let drain: Promise<void> | undefined;
	let wakeRequested = false;

	function open() {
		requireOpenQueue();
		return connect();
	}

	function connect() {
		if (database) return database;

		const connection: Promise<IDBDatabase> = openOutbox().then(
			(db) => {
				const invalidate = () => {
					if (database !== connection) return;

					database = undefined;
					verifiedOrder = undefined;
					stop();
				};
				db.addEventListener("versionchange", invalidate, { once: true });
				db.addEventListener("close", invalidate, { once: true });
				return db;
			},
			(error: unknown) => {
				if (database === connection) database = undefined;
				throw error;
			},
		);
		database = connection;
		return connection;
	}

	function requireOpenQueue() {
		if (closing) throw new Error("collection queue is closed");
	}

	function stop() {
		const lease = active;
		active = undefined;
		clearTimeout(retry);
		clearTimeout(coalesce);
		coalesce = undefined;
		window.removeEventListener("online", wake);
		document.removeEventListener("visibilitychange", wake);
		openingGrant?.abort(new Error("collection consent setup was stopped"));
		lease?.controller.abort();
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
			lease.controller.signal.throwIfAborted();
			const result = await updateOutbox(
				await open(),
				scope,
				async (state, outbox) => {
					if (
						state?.generation !== lease.generation ||
						state.cleanupPending ||
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
				if (
					!state ||
					state.generation !== lease.generation ||
					state.cleanupPending
				)
					return;
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
				if (
					!state ||
					state.generation !== lease.generation ||
					state.cleanupPending
				)
					return;
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
			message: MessageEvent<{
				scope?: string;
				generation?: string;
				withdrawal?: string;
				order?: ConsentOrder;
			}>,
		) => {
			const notice = message.data;
			if (notice?.scope !== scope || typeof notice.generation !== "string")
				return;

			const matchesActive = active?.generation === notice.generation;
			if (active && !matchesActive) return;
			if (
				!matchesActive &&
				verifiedOrder &&
				notice.order?.lineage === verifiedOrder.lineage &&
				notice.order.revision < verifiedOrder.revision
			)
				return;

			const id =
				typeof notice.withdrawal === "string"
					? notice.withdrawal
					: notice.generation;
			const notices = withdrawals.get(notice.generation) ?? new Set<string>();
			const duplicate = notices.has(id);
			// Keep notices across failed grants and while collection is inactive.
			notices.add(id);
			withdrawals.set(notice.generation, notices);
			if (!duplicate)
				openingGrant?.abort(
					new Error("collection consent was withdrawn during setup"),
				);
			if (matchesActive) stop();
		};
	}

	async function openGrant(signal: AbortSignal) {
		watchRevocation();
		const db = await open();
		signal.throwIfAborted();

		const state = await updateOutbox(db, scope, async (state, outbox) => {
			signal.throwIfAborted();
			// An explicit new grant may complete a withdrawal this tab already saw.
			if (state && !state.cleanupPending && !withdrawals.has(state.generation))
				return state;
			if (state) await outbox.removeAll();
			signal.throwIfAborted();

			const created = nextGeneration(crypto.randomUUID(), state);
			outbox.setConsent(created);
			return created;
		});
		const isCurrent = await updateOutbox(
			db,
			scope,
			(current) =>
				current?.generation === state.generation && !current.cleanupPending,
		);
		signal.throwIfAborted();
		if (!isCurrent)
			throw new Error("collection consent was withdrawn during setup");

		withdrawals.clear();
		verifiedOrder = consentOrder(state);
		active = {
			generation: state.generation,
			order: verifiedOrder,
			controller: new AbortController(),
		};
		return active.controller.signal;
	}

	function announceWithdrawal(target: Generation, withdrawal: string) {
		channel?.postMessage({ scope, ...target, withdrawal });
	}

	/** Reads a retry from host storage before changing the queue or collector state. */
	function readWithdrawalRetry(value: unknown): WithdrawalRetry {
		const { scope: targetScope, generation, marker } = readObject(value);
		if (
			targetScope !== scope ||
			(generation !== null && typeof generation !== "string") ||
			typeof marker !== "string"
		)
			throw new TypeError("invalid withdrawal retry for this collection scope");

		return { scope, generation, marker };
	}

	async function withdraw(fallback?: Generation, retry?: WithdrawalRetry) {
		let target = retry ?? failedWithdrawal?.target;
		const known = target ? undefined : fallback;
		if (known) {
			target = {
				scope,
				generation: known.generation,
				marker: crypto.randomUUID(),
			};
		}

		let notified = false;
		try {
			watchRevocation();
			const db = await connect();
			const marker = await updateOutbox(db, scope, (state, outbox) => {
				if (target) {
					if (state?.generation === target.marker)
						return state.cleanupPending ? target.marker : undefined;
					if (
						state?.cleanupPending &&
						state.withdrawnGeneration === target.generation
					)
						return state.generation;
					if ((state?.generation ?? null) !== target.generation) return;
				} else {
					target = {
						scope,
						generation: state?.generation ?? null,
						marker: state?.cleanupPending
							? state.generation
							: crypto.randomUUID(),
					};
				}
				if (state?.cleanupPending) return state.generation;

				// Notify before the write so a failed transaction still stops peers.
				if (state)
					announceWithdrawal(
						{ generation: state.generation, order: consentOrder(state) },
						target.marker,
					);
				notified = true;
				outbox.setConsent({
					...nextGeneration(target.marker, state),
					cleanupPending: true,
					withdrawnGeneration: target.generation,
				});
				return target.marker;
			});
			if (marker !== undefined) {
				await updateOutbox(db, scope, async (state, outbox) => {
					if (!state?.cleanupPending || state.generation !== marker) return;

					await outbox.removeAll();
					outbox.setConsent({ generation: marker, order: consentOrder(state) });
				});
			}
		} catch (error) {
			if (!notified && known && target)
				announceWithdrawal(known, target.marker);
			failedWithdrawal = { target };
			throw new ConsentWithdrawalError(
				error,
				target && Object.freeze({ ...target }),
			);
		}
		failedWithdrawal = undefined;
	}

	async function scheduleWithdrawal(
		after: Promise<void>,
		retry?: WithdrawalRetry,
	) {
		requireOpenQueue();
		if (retry && active)
			throw new Error("withdrawal retry requires an inactive queue");

		// A repeated withdrawal must not target a grant created by a peer in the meantime.
		if (!retry && withdrawing && !withdrawing.retry) return withdrawing.done;

		const generation = active && {
			generation: active.generation,
			order: active.order,
		};
		const previous = withdrawing?.done.catch(() => {});
		const scheduled = Promise.all([after, previous])
			.then(() => {
				if (
					retry &&
					failedWithdrawal?.target &&
					failedWithdrawal.target.marker !== retry.marker
				)
					throw new Error("another withdrawal must be completed first");

				return withdraw(generation, retry);
			})
			.finally(() => {
				if (withdrawing?.done === scheduled) withdrawing = undefined;
			});

		// Register the work before publishing the abort, whose listeners can call close().
		withdrawing = { done: scheduled, retry: retry !== undefined };
		stop();
		return scheduled;
	}

	return {
		readWithdrawalRetry,

		resume() {
			if (!active) return;
			window.addEventListener("online", wake);
			document.addEventListener("visibilitychange", wake);
			wake();
		},

		/** Opens this tab's consent lease before delivery starts. */
		async grant() {
			requireOpenQueue();
			if (withdrawing || failedWithdrawal)
				throw new Error(
					"withdrawal cleanup must complete before collection resumes",
				);
			if (active) return active.controller.signal;
			if (granting) return granting;

			openingGrant = new AbortController();
			granting = openGrant(openingGrant.signal).finally(() => {
				openingGrant = undefined;
				granting = undefined;
			});
			return granting;
		},

		/** Aborts this tab and deletes session and queued data for every tab in the scope. */
		revoke(after = Promise.resolve()) {
			return scheduleWithdrawal(after);
		},

		/** Resumes an earlier withdrawal without changing a newer generation. */
		async retryWithdrawal(retry: WithdrawalRetry, after = Promise.resolve()) {
			return scheduleWithdrawal(after, readWithdrawalRetry(retry));
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
								state.cleanupPending ||
								lease.controller.signal.aborted
							)
								return;
							const session = select(state.session);
							outbox.setConsent({ ...state, session });
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

		/** Stops delivery and releases resources after scheduled withdrawals settle. */
		close() {
			if (closing) return closing;

			closing = (withdrawing?.done.catch(() => {}) ?? Promise.resolve()).then(
				async () => {
					channel?.close();
					channel = undefined;
					const db = await database?.catch(() => undefined);
					database = undefined;
					db?.close();
				},
			);
			wakeRequested = false;
			stop();
			return closing;
		},
	};
}

export type QueuedDelivery = ReturnType<typeof createQueuedDelivery>;
