import type { Envelope } from "./records.ts";

export type QueuedEvent = {
	scope: string;
	record: Envelope;
	encodedBytes?: number;
	expiresAt: number;
	nextAttempt: number;
	attempts: number;
	priority: 0 | 1;
};

/** Protects clicks and other outcomes from impression bursts. */
export function deliveryPriority({ kind, payload }: Envelope): 0 | 1 {
	return kind === "event" &&
		(payload.action_name === "result_impression" ||
			payload.action_name === "impression")
		? 1
		: 0;
}

export type ConsentState = { generation: string; session?: unknown };

function result<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

export function openOutbox(): Promise<IDBDatabase> {
	const request = indexedDB.open("liatris-delivery", 2);
	let blocked = false;
	const opening = new Promise<IDBDatabase>((resolve, reject) => {
		request.onblocked = () => {
			blocked = true;
			reject(new Error("collection storage upgrade blocked"));
		};
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			if (blocked) request.result.close();
			else resolve(request.result);
		};
	});

	request.onupgradeneeded = (event) => {
		const db = request.result;
		const tx = request.transaction;
		if (!tx)
			throw new Error("collection storage upgrade is missing a transaction");

		if (event.oldVersion === 0) {
			db.createObjectStore("scopes");
			db.createObjectStore("outbox", {
				keyPath: ["scope", "record.event_id"],
			}).createIndex("scope", "scope");
		}
		const events = tx.objectStore("outbox");
		events.createIndex("expiry", ["scope", "expiresAt"]);
		events.createIndex("ready", [
			"scope",
			"record.profile_hash",
			"priority",
			"nextAttempt",
		]);
		if (event.oldVersion === 1) {
			const scan = events.openCursor();
			scan.onsuccess = () => {
				const cursor = scan.result;
				if (!cursor) return;

				const entry = cursor.value as Omit<QueuedEvent, "priority">;
				cursor.update({ ...entry, priority: deliveryPriority(entry.record) });
				cursor.continue();
			};
		}
	};
	return opening.then((db) => {
		db.onversionchange = () => db.close();
		return db;
	});
}

/** Runs queue and consent changes in a single committed IndexedDB transaction. */
export async function updateOutbox<T>(
	db: IDBDatabase,
	scope: string,
	update: (
		state: ConsentState | undefined,
		outbox: {
			setConsent: (state: ConsentState) => void;
			get: (id: string) => Promise<QueuedEvent | undefined>;
			has: (id: string) => Promise<boolean>;
			count: () => Promise<number>;
			removeAll: () => Promise<void>;
			expire: (now: number) => Promise<number>;
			ready: (
				profileHash: string,
				now: number,
				limit: number,
			) => Promise<QueuedEvent[]>;
			nextAttempt: (profileHash: string, now: number) => Promise<number>;
			put: (entry: QueuedEvent) => void;
			remove: (id: string) => void;
		},
	) => T | Promise<T>,
): Promise<T> {
	const tx = db.transaction(["scopes", "outbox"], "readwrite");
	const completed = new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () =>
			reject(tx.error ?? new Error("collection storage transaction aborted"));
	});
	void completed.catch(() => {});
	const scopes = tx.objectStore("scopes");
	const events = tx.objectStore("outbox");

	try {
		const state = (await result(scopes.get(scope))) as ConsentState | undefined;
		const value = await update(state, {
			setConsent: (state) => {
				scopes.put(state, scope);
			},
			get: (id) => result(events.get([scope, id])),
			has: async (id) =>
				(await result(events.getKey([scope, id]))) !== undefined,
			count: () => result(events.index("scope").count(scope)),
			async removeAll() {
				const keys = await result(events.index("scope").getAllKeys(scope));
				for (const key of keys) events.delete(key);
			},
			async expire(now) {
				const range = IDBKeyRange.bound([scope, 0], [scope, now]);
				const keys = await result(events.index("expiry").getAllKeys(range));
				for (const key of keys) events.delete(key);
				return keys.length;
			},
			async ready(profileHash, now, limit) {
				const index = events.index("ready");
				const range = (priority: 0 | 1) =>
					IDBKeyRange.bound(
						[scope, profileHash, priority, 0],
						[scope, profileHash, priority, now],
					);
				const first = await result<QueuedEvent[]>(
					index.getAll(range(0), limit),
				);
				if (first.length === limit) return first;
				const second = await result<QueuedEvent[]>(
					index.getAll(range(1), limit - first.length),
				);
				return first.concat(second);
			},
			async nextAttempt(profileHash, now) {
				const index = events.index("ready");
				const find = (priority: 0 | 1) =>
					result(
						index.openKeyCursor(
							IDBKeyRange.bound(
								[scope, profileHash, priority, now],
								[scope, profileHash, priority, Number.MAX_SAFE_INTEGER],
								true,
							),
						),
					);
				const [high, low] = await Promise.all([find(0), find(1)]);
				return Math.min(
					high ? (high.key as [string, string, number, number])[3] : Infinity,
					low ? (low.key as [string, string, number, number])[3] : Infinity,
				);
			},
			put: (entry) => {
				events.put(entry);
			},
			remove: (id) => {
				events.delete([scope, id]);
			},
		});
		await completed;
		return value;
	} catch (error) {
		try {
			tx.abort();
		} catch {
			/* The failed transaction may already be closed. */
		}
		await completed.catch(() => {});
		throw error;
	}
}
