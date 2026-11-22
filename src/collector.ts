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
		anchor?: Activity,
		now = Date.now(),
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

		record.event_id = crypto.randomUUID();
		setSessionId(record, assigned.sessionId);

		try {
			await deliver(record, signal);
		} catch (error) {
			if (!signal.aborted) throw error;
		}
		return signal.aborted ? "no-consent" : "sent";
	}

	return {
		setConsent,
		/** Binds later observations to the most recent activity queued in this collector. */
		bindObservation() {
			const signal = consent?.signal;
			if (!signal) return;
			const anchor = sessionTail.then(() => lastActivity);

			return {
				signal,
				async trackEvent(
					name: string,
					value: EventInput = {},
				): Promise<Status | "no-session"> {
					const observedAt = Date.now();
					const activity = await anchor;
					if (signal.aborted) return "no-consent";
					if (!activity) return "no-session";

					const data = readEvent(profile, name, value);
					return capture(signal, "event", data, activity, observedAt);
				},
				async sessionElapsedMs(at = Date.now()) {
					const activity = await anchor;
					if (!signal.aborted && activity)
						return Math.max(0, at - activity.startedAtMs);
				},
			};
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
