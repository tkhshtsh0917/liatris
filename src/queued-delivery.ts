import type { Delivery } from "./collector.ts";
import { HttpDeliveryError } from "./http-delivery.ts";
import {
	type ConsentState,
	openOutbox,
	type QueuedEvent,
	updateOutbox,
} from "./outbox-storage.ts";
import type { Profile } from "./profile.ts";
import type { Envelope } from "./records.ts";
import type { SessionStore } from "./session-store.ts";

type DropReason = "expired" | "capacity" | "rejected";
type Options = {
	profile: Pick<Profile, "tenant" | "application">;
	profileHash: string;
	send: Delivery;
	onDrop?: (reason: DropReason) => void;
};

const capacity = 64;
const retentionMs = 24 * 60 * 60_000;
const requestTimeoutMs = 15_000;

/** Creates an opt-in IndexedDB queue for a single collection scope. */
export function createQueuedDelivery({
	profile,
	profileHash,
	send,
	onDrop,
}: Options) {
	const scope = JSON.stringify([profile.tenant, profile.application]);
	let database: Promise<IDBDatabase> | undefined;
	let channel: BroadcastChannel | undefined;
	let active: { generation: string; controller: AbortController } | undefined;
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

	async function expire() {
		const lease = active;
		if (!lease) return;

		const next = await updateOutbox(
			await open(),
			scope,
			async (state, outbox) => {
				if (!state || state.generation !== lease.generation) return;
				const now = Date.now();
				const pending: QueuedEvent[] = [];
				let expired = 0;
				for (const entry of await outbox.list()) {
					if (entry.expiresAt <= now) {
						outbox.remove(entry.record.event_id);
						expired++;
					} else if (entry.record.profile_hash === profileHash) {
						pending.push(entry);
					}
				}
				pending.sort((a, b) => a.nextAttempt - b.nextAttempt);
				return { entry: pending[0], expired };
			},
		);
		if (active !== lease) return;
		if (!next) {
			stop();
			return;
		}

		for (let i = 0; i < next.expired; i++) notify("expired");
		const { entry } = next;
		if (!entry) return;
		if (entry.nextAttempt > Date.now()) {
			schedule(Math.min(entry.nextAttempt, entry.expiresAt));
			return;
		}

		let failure: unknown;
		let delivered = false;
		try {
			await send(
				entry.record,
				AbortSignal.any([
					lease.controller.signal,
					AbortSignal.timeout(requestTimeoutMs),
				]),
			);
			delivered = true;
		} catch (error) {
			failure = error;
		}
		if (lease.controller.signal.aborted) return;
		const permanent =
			failure instanceof HttpDeliveryError && !failure.retryable;
		const updated = await updateOutbox(
			await open(),
			scope,
			async (state, outbox) => {
				if (!state || state.generation !== lease.generation) return false;
				const current = (await outbox.list()).find(
					(item) => item.record.event_id === entry.record.event_id,
				);
				if (!current) return true;

				if (delivered || permanent) outbox.remove(entry.record.event_id);
				else if (current.attempts === entry.attempts) {
					const delay = Math.min(
						300_000,
						1000 * 2 ** Math.min(entry.attempts, 9),
					);
					const retryAfter =
						failure instanceof HttpDeliveryError ? failure.retryAfterMs : 0;
					outbox.put({
						...entry,
						attempts: entry.attempts + 1,
						nextAttempt:
							Date.now() +
							Math.max(retryAfter, delay * (0.5 + Math.random() * 0.5)),
					});
				}
				return true;
			},
		);
		if (updated && permanent) notify("rejected");
		if (active === lease) {
			if (updated) wakeRequested = true;
			else stop();
		}
	}

	function wake() {
		if (!active) return;
		clearTimeout(retry);
		if (drain) {
			wakeRequested = true;
			return;
		}
		drain = expire()
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
			)
				stop();
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
			const state = await updateOutbox(await open(), scope, (state, outbox) => {
				if (state) return state;
				const created = { generation: crypto.randomUUID() };
				outbox.setConsent(created);
				return created;
			});
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
			return active.controller.signal;
		},

		/** Aborts this tab and deletes session and queued data for every tab in the scope. */
		async revoke() {
			stop();
			watchRevocation();
			await updateOutbox(await open(), scope, async (state, outbox) => {
				if (state)
					channel?.postMessage({ scope, generation: state.generation });
				const next: ConsentState = { generation: crypto.randomUUID() };
				outbox.setConsent(next);
				for (const entry of await outbox.list())
					outbox.remove(entry.record.event_id);
			});
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
			const stored = await updateOutbox(
				await open(),
				scope,
				async (state, outbox) => {
					if (
						state?.generation !== lease.generation ||
						lease.controller.signal.aborted ||
						signal.aborted
					)
						return;
					const now = Date.now();
					let occupied = 0;
					let expired = 0;
					for (const entry of await outbox.list()) {
						if (entry.expiresAt <= now) {
							outbox.remove(entry.record.event_id);
							expired++;
						} else occupied++;
					}
					if (signal.aborted || lease.controller.signal.aborted) return;
					if (occupied >= capacity) return { accepted: false, expired };
					outbox.put({
						scope,
						record,
						expiresAt: now + retentionMs,
						nextAttempt: now,
						attempts: 0,
					});
					return { accepted: true, expired };
				},
			);
			if (stored === undefined) {
				if (active === lease) stop();
				throw new Error("collection consent was withdrawn");
			}
			for (let i = 0; i < stored.expired; i++) notify("expired");
			if (!stored.accepted) {
				notify("capacity");
				throw new RangeError("collection queue is full");
			}
			wake();
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
