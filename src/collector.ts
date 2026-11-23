import { maxBatchEvents } from "./batch.ts";
import type { Profile } from "./profile.ts";
import type { QueuedDelivery, WithdrawalRetry } from "./queued-delivery.ts";
import {
	type Envelope,
	type EventInput,
	maxRecordBytes,
	type QueryInput,
	readEvent,
	readQuery,
} from "./records.ts";
import { clearSession, createSessionManager } from "./session.ts";
import type { SessionStore } from "./session-store.ts";

export {
	createHttpBatchDelivery,
	createHttpDelivery,
} from "./http-delivery.ts";
export {
	ConsentWithdrawalError,
	type WithdrawalRetry,
} from "./queued-delivery.ts";

export type Delivery = (record: Envelope, signal: AbortSignal) => Promise<void>;
type Status = "sent" | "queued" | "no-consent" | "query-text-disabled";

type Options = {
	profile: Profile;
	profileHash: string;
} & (
	| { openStore: () => Promise<SessionStore>; deliver: Delivery; queue?: never }
	| { queue: QueuedDelivery; openStore?: never; deliver?: never }
);

const placeholderId = "00000000-0000-4000-8000-000000000000";

function setSessionId(record: Envelope, sessionId: string) {
	if (record.kind === "query") {
		record.payload.query_attributes = {
			...(record.payload.query_attributes as Record<string, unknown>),
			session_id: sessionId,
		};
	} else {
		record.payload.session_id = sessionId;
	}
}

type Session = ReturnType<typeof createSessionManager>;
type Activity = Awaited<ReturnType<Session["recordActivity"]>>;
type PendingActivity = {
	at: number;
	resolve: (activity: Activity | undefined) => void;
	reject: (error: unknown) => void;
};
type ActivityGroup = { signal: AbortSignal; requests: PendingActivity[] };

/** Captures explicitly declared events after the host grants consent. */
export function createCollector({
	profile,
	profileHash,
	openStore,
	deliver,
	queue,
}: Options) {
	const openSessionStore = queue?.openSessionStore ?? openStore;
	if (!openSessionStore || (!queue && !deliver)) {
		throw new TypeError("a delivery and session store are required");
	}
	const initializeStore = openSessionStore;
	let consent: AbortController | undefined;
	let session: Session | undefined;
	let sessionTail = Promise.resolve();
	let store: SessionStore | undefined;
	let consentVersion = 0;
	let cleanupRequired = false;
	let latestAssignment: Promise<Activity | undefined> | undefined;
	let waiting: ActivityGroup | undefined;

	function withinSession<T>(operation: () => Promise<T>) {
		const running = sessionTail.then(operation);
		sessionTail = running.then(
			() => {},
			() => {},
		);
		return running;
	}

	async function getSession(signal: AbortSignal) {
		if (!session) {
			if (signal.aborted) return;
			store ??= await initializeStore();
			if (signal.aborted) return;
			session = createSessionManager(
				store,
				profile,
				profile.session.inactivityMinutes,
			);
		}
		return signal.aborted ? undefined : session;
	}

	async function assignGroup({ signal, requests }: ActivityGroup) {
		const manager = signal.aborted ? undefined : await getSession(signal);
		const outcomes =
			manager && (await manager.recordActivities(requests.map(({ at }) => at)));
		for (const [index, request] of requests.entries()) {
			const outcome = outcomes?.[index];
			if (signal.aborted || !outcome) request.resolve(undefined);
			else if ("error" in outcome) request.reject(outcome.error);
			else request.resolve(outcome.activity);
		}
	}

	function assignActivity(signal: AbortSignal, at: number) {
		const maxGroup = queue ? maxBatchEvents : 1;
		if (waiting?.signal !== signal || waiting.requests.length === maxGroup) {
			const group: ActivityGroup = { signal, requests: [] };
			waiting = group;
			void withinSession(async () => {
				if (waiting === group) waiting = undefined;
				await assignGroup(group);
			}).catch((error: unknown) => {
				for (const request of group.requests) request.reject(error);
			});
		}
		const { promise, resolve, reject } = Promise.withResolvers<
			Activity | undefined
		>();
		waiting.requests.push({ at, resolve, reject });
		latestAssignment = promise;
		return promise;
	}

	/** Grants capture for this collector or withdraws consent and clears persisted state. */
	async function setConsent(granted: boolean) {
		if (!granted) return withdrawConsent();

		const version = ++consentVersion;
		await sessionTail;
		if (version !== consentVersion) return;
		if (cleanupRequired)
			throw new Error(
				"session cleanup must complete before collection resumes",
			);
		if (consent) return;

		const controller = new AbortController();
		if (queue) {
			let signal: AbortSignal;
			try {
				signal = await withinSession(() => queue.grant());
			} catch (error) {
				if (version !== consentVersion) return;
				throw error;
			}
			if (version !== consentVersion || signal.aborted) return;
			signal.addEventListener(
				"abort",
				() => {
					if (consent === controller) {
						consent = undefined;
						latestAssignment = undefined;
						session = undefined;
						controller.abort();
					}
				},
				{ once: true },
			);
		}
		consent = controller;
		queue?.resume();
	}

	async function withdrawConsent(retry?: WithdrawalRetry) {
		++consentVersion;

		const previous = consent;
		consent = undefined;
		const previousGeneration = queue?.suspend();
		latestAssignment = undefined;
		cleanupRequired = true;
		const cleanup = withinSession(async () => {
			cleanupRequired = true;
			if (queue) {
				if (retry) await queue.retryWithdrawal(retry);
				else await queue.revoke(previousGeneration);
			} else {
				store ??= await initializeStore();
				await clearSession(store, profile);
			}
			session = undefined;
			cleanupRequired = false;
		});
		previous?.abort();
		await cleanup;
	}

	async function capture(
		signal: AbortSignal,
		kind: Envelope["kind"],
		data: {
			payload: Envelope["payload"];
			metadata: NonNullable<Envelope["metadata"]>;
		},
		{
			anchor,
			now = Date.now(),
			onAssigned,
		}: {
			anchor?: Activity;
			now?: number;
			onAssigned?: (activity: Activity) => void;
		} = {},
	): Promise<Status> {
		const record: Envelope = {
			event_id: placeholderId,
			profile_hash: profileHash,
			kind,
			payload: {
				...data.payload,
				application: profile.application,
				timestamp: new Date(now).toISOString(),
			},
			...(Object.keys(data.metadata).length > 0
				? { metadata: data.metadata }
				: {}),
		};

		// UUIDs serialize to the same number of bytes as the placeholders.
		setSessionId(record, placeholderId);
		if (
			new TextEncoder().encode(JSON.stringify(record)).length > maxRecordBytes
		) {
			throw new RangeError("record too large");
		}

		const assigned =
			anchor ??
			(await assignActivity(signal, now).catch((error: unknown) => {
				if (!signal.aborted) throw error;
			}));
		if (!assigned || signal.aborted) return "no-consent";

		onAssigned?.(assigned);
		record.event_id = crypto.randomUUID();
		setSessionId(record, assigned.sessionId);

		try {
			if (queue) await queue.enqueue(record, signal);
			else await deliver?.(record, signal);
		} catch (error) {
			if (!signal.aborted) throw error;
		}
		if (signal.aborted) return "no-consent";
		return queue ? "queued" : "sent";
	}

	function createObservation(
		signal: AbortSignal,
		anchor: Promise<Activity | undefined>,
	) {
		async function dispatch(
			record: (activity: Activity, at: number) => Promise<Status> | Status,
		): Promise<Status | "no-session"> {
			const at = Date.now();
			const activity = await anchor;
			if (signal.aborted) return "no-consent";
			if (!activity) return "no-session";
			return record(activity, at);
		}

		return {
			signal,
			trackQuery(value: QueryInput) {
				return dispatch((anchor, now) => {
					if (!profile.allowQueryText) return "query-text-disabled";
					const payload = readQuery(profile, value);
					return capture(
						signal,
						"query",
						{ payload, metadata: {} },
						{ anchor, now },
					);
				});
			},
			trackEvent(name: string, value: EventInput = {}) {
				return dispatch((anchor, now) => {
					const data = readEvent(profile, name, value);
					return capture(signal, "event", data, { anchor, now });
				});
			},
			async sessionElapsedMs(at = Date.now()) {
				const activity = await anchor;
				if (!signal.aborted && activity)
					return Math.max(0, at - activity.startedAtMs);
			},
		};
	}

	return {
		setConsent,
		/** Retries a queued withdrawal before enabling capture, including after reload. */
		async retryConsentWithdrawal(retry: WithdrawalRetry) {
			if (!queue || consent)
				throw new Error(
					"withdrawal retry requires an inactive queued collector",
				);
			await withdrawConsent(queue.readWithdrawalRetry(retry));
		},
		/** The active grant's signal, aborted on local or shared revocation. */
		get consentSignal(): AbortSignal | undefined {
			return consent?.signal;
		},
		/** Binds later observations to the most recent activity queued in this collector. */
		bindObservation() {
			const signal = consent?.signal;
			if (signal)
				return createObservation(
					signal,
					latestAssignment?.catch(() => undefined) ??
						Promise.resolve(undefined),
				);
		},
		/** Records a live event and binds subsequent observations to that exact event's session. */
		trackEventWithObservation(name: string, value: EventInput = {}) {
			const signal = consent?.signal;
			if (!signal) return { delivery: Promise.resolve<Status>("no-consent") };

			const { promise, resolve } = Promise.withResolvers<
				Activity | undefined
			>();
			const delivery = (async () => {
				try {
					const data = readEvent(profile, name, value);
					return await capture(signal, "event", data, { onAssigned: resolve });
				} finally {
					resolve(undefined);
				}
			})();

			return { delivery, observation: createObservation(signal, promise) };
		},
		async trackQuery(value: QueryInput): Promise<Status> {
			if (!consent) return "no-consent";
			if (!profile.allowQueryText) return "query-text-disabled";

			const payload = readQuery(profile, value);
			return capture(consent.signal, "query", { payload, metadata: {} });
		},
		async trackEvent(name: string, value: EventInput = {}): Promise<Status> {
			if (!consent) return "no-consent";

			const data = readEvent(profile, name, value);
			return capture(consent.signal, "event", data);
		},
	};
}
