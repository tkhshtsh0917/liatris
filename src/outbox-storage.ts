import type { Envelope } from "./records.ts";

export type QueuedEvent = {
	scope: string;
	record: Envelope;
	expiresAt: number;
	nextAttempt: number;
	attempts: number;
};

export type ConsentState = { generation: string; session?: unknown };

function result<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

export function openOutbox(): Promise<IDBDatabase> {
	const request = indexedDB.open("liatris-delivery", 1);
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
	request.onupgradeneeded = () => {
		const db = request.result;
		db.createObjectStore("scopes");
		db.createObjectStore("outbox", {
			keyPath: ["scope", "record.event_id"],
		}).createIndex("scope", "scope");
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
			list: () => Promise<QueuedEvent[]>;
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
			list: () => result(events.index("scope").getAll(scope)),
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
