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

type Session = Awaited<ReturnType<typeof createSessionManager>>;

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
	): Promise<Status> {
		const now = Date.now();
		const record: Envelope = {
			event_id: "00000000-0000-4000-8000-000000000000",
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

		// Reserve enough bytes for the generated session ID and its enclosing fields.
		if (
			new TextEncoder().encode(JSON.stringify(record)).length >
			maxRecordBytes - 100
		) {
			throw new RangeError("record too large");
		}

		const assigned = await withinSession(async () => {
			if (signal.aborted) return;
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
			return session.recordActivity(now);
		});
		if (!assigned || signal.aborted) return "no-consent";

		record.event_id = crypto.randomUUID();
		if (kind === "query") {
			record.payload.query_attributes = {
				...(record.payload.query_attributes as Record<string, unknown>),
				session_id: assigned.sessionId,
			};
		} else {
			record.payload.session_id = assigned.sessionId;
		}

		try {
			await deliver(record, signal);
		} catch (error) {
			if (!signal.aborted) throw error;
		}
		return signal.aborted ? "no-consent" : "sent";
	}

	return {
		setConsent,
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
