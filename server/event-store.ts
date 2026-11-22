import { DatabaseSync } from "node:sqlite";
import type { Profile } from "../src/profile.ts";
import type { Envelope } from "../src/records.ts";
import { EventConflictError } from "./intake-error.ts";

type Scope = Pick<Profile, "tenant" | "application">;

/** Serializes validated JSON consistently for idempotency comparisons. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	const entries = Object.entries(value).sort(([a], [b]) =>
		a < b ? -1 : Number(a > b),
	);
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

/** Saves each accepted event and its forwarding status in one SQLite row. */
export function openEventStore(path: string, { tenant, application }: Scope) {
	const db = new DatabaseSync(path);
	try {
		db.exec(`
			PRAGMA busy_timeout = 5000;
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = FULL;
			CREATE TABLE IF NOT EXISTS events (
				tenant TEXT NOT NULL,
				application TEXT NOT NULL,
				event_id TEXT NOT NULL,
				envelope TEXT NOT NULL,
				received_at INTEGER NOT NULL,
				forwarded_at INTEGER,
				PRIMARY KEY (tenant, application, event_id)
			) STRICT;
			CREATE INDEX IF NOT EXISTS pending_events
			ON events (tenant, application, received_at)
			WHERE forwarded_at IS NULL;
		`);
	} catch (error) {
		db.close();
		throw error;
	}

	const insert = db.prepare(`
		INSERT INTO events (tenant, application, event_id, envelope, received_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (tenant, application, event_id) DO NOTHING
	`);
	const find = db.prepare(`
		SELECT envelope FROM events WHERE tenant = ? AND application = ? AND event_id = ?
	`);
	const pending = db.prepare(`
		SELECT envelope FROM events WHERE tenant = ? AND application = ? AND forwarded_at IS NULL
		ORDER BY received_at, rowid LIMIT ?
	`);
	const forwarded = db.prepare(`
		UPDATE events SET forwarded_at = ? WHERE tenant = ? AND application = ? AND event_id = ?
		AND forwarded_at IS NULL
	`);

	return {
		async accept(record: Envelope): Promise<void> {
			const body = canonical(record);
			const { changes } = insert.run(
				tenant,
				application,
				record.event_id,
				body,
				Date.now(),
			);
			if (
				changes === 0 &&
				find.get(tenant, application, record.event_id)?.envelope !== body
			) {
				throw new EventConflictError(
					"event ID already has a different payload",
				);
			}
		},
		pending(limit: number): Envelope[] {
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
				throw new RangeError("pending limit must be between 1 and 500");
			}
			return pending
				.all(tenant, application, limit)
				.map((row) => JSON.parse(String(row.envelope)) as Envelope);
		},
		markForwarded(ids: readonly string[]) {
			if (ids.length === 0) return;
			const now = Date.now();
			db.exec("BEGIN IMMEDIATE");
			try {
				for (const id of ids) forwarded.run(now, tenant, application, id);
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		close() {
			db.close();
		},
	};
}
