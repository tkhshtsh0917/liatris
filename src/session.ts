import type { SessionState, SessionStore } from "./session-store.ts";

const minuteMs = 60_000;
const maxIdleMs = 24 * 60 * minuteMs;
const maxClockRollbackMs = 5 * minuteMs;
export const defaultIdleMs = 30 * minuteMs;

const uuidV4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maxDateMs = 8_640_000_000_000_000;

function isTime(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= maxDateMs
	);
}

/** Returns invalid, keep or start for timestamps in the persisted session format. */
export function sessionTransition(
	now: number,
	previous: number,
	idleMs: number,
) {
	const idle = idleMs === 0 ? defaultIdleMs : idleMs;
	if (
		!isTime(now) ||
		!Number.isInteger(idle) ||
		idle < minuteMs ||
		idle > maxIdleMs
	)
		return 0;
	if (previous === -1) return 2;
	if (!isTime(previous)) return 0;

	const elapsed = now - previous;
	return elapsed >= idle || elapsed < -maxClockRollbackMs ? 2 : 1;
}

function readState(value: unknown): SessionState | undefined {
	if (value === null || typeof value !== "object") return;
	const state = value as Partial<SessionState>;
	if (
		typeof state.id === "string" &&
		uuidV4.test(state.id) &&
		typeof state.number === "number" &&
		Number.isSafeInteger(state.number) &&
		state.number > 0 &&
		isTime(state.startedAtMs) &&
		isTime(state.lastActivityMs) &&
		state.startedAtMs <= state.lastActivityMs
	) {
		return state as SessionState;
	}
}

type Activity = {
	sessionId: string;
	sessionNumber: number;
	startedAtMs: number;
	started: boolean;
};
type ActivityOutcome = { activity: Activity } | { error: unknown };

type Scope = { tenant: string; application: string };

function scopeKey({ tenant, application }: Scope) {
	return JSON.stringify([tenant, application]);
}

/** Removes persisted identifiers for a scope even when capture has not initialized. */
export async function clearSession(store: SessionStore, scope: Scope) {
	await store.update(scopeKey(scope), () => null);
}

/** Creates a manager that updates the scope through its supplied session store. */
export function createSessionManager(
	store: SessionStore,
	scope: Scope,
	inactivityMinutes?: number,
) {
	const { tenant, application } = scope;
	if ([tenant, application].some((part) => !part.trim() || part.length > 100)) {
		throw new RangeError("invalid session scope");
	}
	if (
		inactivityMinutes !== undefined &&
		(!Number.isInteger(inactivityMinutes) ||
			inactivityMinutes < 1 ||
			inactivityMinutes > 1440)
	) {
		throw new RangeError("invalid inactivity timeout");
	}

	const key = scopeKey(scope);
	const idleMs =
		inactivityMinutes === undefined
			? defaultIdleMs
			: inactivityMinutes * minuteMs;

	function advance(previous: SessionState | undefined, nowMs: number) {
		const decision = sessionTransition(
			nowMs,
			previous?.lastActivityMs ?? -1,
			idleMs,
		);
		if (decision === 1 && previous) {
			return {
				...previous,
				lastActivityMs: Math.max(nowMs, previous.lastActivityMs),
			};
		}
		if (decision !== 2)
			throw new RangeError("invalid activity time or policy result");

		const number = (previous?.number ?? 0) + 1;
		if (!Number.isSafeInteger(number))
			throw new RangeError("session counter exhausted");
		return {
			id: crypto.randomUUID(),
			number,
			startedAtMs: nowMs,
			lastActivityMs: nowMs,
		};
	}

	/** Assigns activities in arrival order, writing the latest session once. */
	async function recordActivities(
		times: readonly number[],
	): Promise<ActivityOutcome[]> {
		if (times.length === 0) return [];
		let outcomes: ActivityOutcome[] = [];
		const unchanged = new Error("no activity to commit");

		try {
			await store.update(key, (stored) => {
				const current: ActivityOutcome[] = [];
				let state = readState(stored);
				let accepted = false;
				for (const time of times) {
					try {
						const previous = state;
						state = advance(previous, time);
						accepted = true;
						current.push({
							activity: {
								sessionId: state.id,
								sessionNumber: state.number,
								startedAtMs: state.startedAtMs,
								started: state.number !== previous?.number,
							},
						});
					} catch (error) {
						current.push({ error });
					}
				}
				outcomes = current;
				if (!accepted || !state) throw unchanged;
				return state;
			});
		} catch (error) {
			if (error !== unchanged) throw error;
		}
		return outcomes;
	}

	return {
		recordActivities,

		/** Assigns a session to one accepted live activity at capture time. */
		async recordActivity(nowMs = Date.now()) {
			const [outcome] = await recordActivities([nowMs]);
			if ("error" in outcome) throw outcome.error;
			return outcome.activity;
		},

		/** Deletes this scope after the host stops accepting activity. */
		async clear() {
			await clearSession(store, scope);
		},
	};
}
