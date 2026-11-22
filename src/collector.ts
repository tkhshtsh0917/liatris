import type { Profile } from "./profile.ts";
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

export { createHttpDelivery } from "./http-delivery.ts";

export type Delivery = (record: Envelope, signal: AbortSignal) => Promise<void>;
type Status = "sent" | "no-consent" | "query-text-disabled";

type Options = {
	profile: Profile;
	profileHash: string;
	openStore: () => Promise<SessionStore>;
	loadWasm: () => Promise<BufferSource>;
	deliver: Delivery;
};

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

type Session = Awaited<ReturnType<typeof createSessionManager>>;
type Activity = Awaited<ReturnType<Session["recordActivity"]>>;

/** Captures explicitly declared events after the host grants consent. */
export function createCollector({
	profile,
	profileHash,
	openStore,
	loadWasm,
	deliver,
}: Options) {
	let consent: AbortController | undefined;
	let session: Session | undefined;
	let sessionTail = Promise.resolve();
	let store: SessionStore | undefined;
	let consentVersion = 0;
	let cleanupRequired = false;
	let lastActivity: Activity | undefined;

	function withinSession<T>(operation: () => Promise<T>) {
		const running = sessionTail.then(operation);
		sessionTail = running.then(
			() => {},
			() => {},
		);
		return running;
	}

	/** Revocation stops capture immediately and clears any prior persisted session. */
	async function setConsent(granted: boolean) {
		const version = ++consentVersion;
		if (granted) {
			await sessionTail;
			if (version !== consentVersion) return;
			if (cleanupRequired)
				throw new Error(
					"session cleanup must complete before collection resumes",
				);
			consent ??= new AbortController();
			return;
		}

		consent?.abort();
		consent = undefined;
		lastActivity = undefined;
		cleanupRequired = true;
		await withinSession(async () => {
			cleanupRequired = true;
			store ??= await openStore();
			await clearSession(store, profile);
			session = undefined;
			cleanupRequired = false;
		});
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
			(await withinSession(async () => {
				if (signal.aborted) return;
				lastActivity = undefined;
				if (!session) {
					const wasm = await loadWasm();
					if (signal.aborted) return;
					store ??= await openStore();
					if (signal.aborted) return;
					session = await createSessionManager(
						wasm,
						store,
						profile,
						profile.session.inactivityMinutes,
					);
				}
				if (signal.aborted) return;
				const activity = await session.recordActivity(now);
				if (!signal.aborted) lastActivity = activity;
				return activity;
			}));
		if (!assigned || signal.aborted) return "no-consent";

		onAssigned?.(assigned);
		record.event_id = crypto.randomUUID();
		setSessionId(record, assigned.sessionId);

		try {
			await deliver(record, signal);
		} catch (error) {
			if (!signal.aborted) throw error;
		}
		return signal.aborted ? "no-consent" : "sent";
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
		/** Binds later observations to the most recent activity queued in this collector. */
		bindObservation() {
			const signal = consent?.signal;
			if (signal)
				return createObservation(
					signal,
					sessionTail.then(() => lastActivity),
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
