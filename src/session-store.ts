/** Persisted state for a single origin and application scope. */
export type SessionState = {
	id: string;
	number: number;
	startedAtMs: number;
	lastActivityMs: number;
};

type Update = (previous: unknown) => SessionState | null;

/** Updates session state atomically and resolves after committing it. */
export interface SessionStore {
	update(key: string, next: Update): Promise<SessionState | null>;
}

/** Explicit nonpersistent mode, for one tab or unit tests. */
export function memorySessionStore(): SessionStore {
	const states = new Map<string, SessionState>();
	return {
		async update(key, next) {
			const state = next(states.get(key));
			if (state === null) states.delete(key);
			else states.set(key, state);
			return state;
		},
	};
}

/** Shares session updates between same-origin tabs using read-write transactions. */
export function openSessionStore(
	factory: IDBFactory = globalThis.indexedDB,
): Promise<SessionStore> {
	return new Promise((resolve, reject) => {
		const open = factory.open("liatris", 1);
		let blocked = false;

		open.onupgradeneeded = () => open.result.createObjectStore("sessions");
		open.onblocked = () => {
			blocked = true;
			reject(new Error("session database upgrade blocked"));
		};
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const db = open.result;
			if (blocked) {
				db.close();
				return;
			}

			db.onversionchange = () => db.close();
			resolve({
				update(key, next) {
					return new Promise((commit, fail) => {
						const tx = db.transaction("sessions", "readwrite");
						const store = tx.objectStore("sessions");
						const read = store.get(key);
						let state: SessionState | null = null;
						let updateError: unknown;

						tx.oncomplete = () => commit(state);
						tx.onabort = () =>
							fail(
								updateError ??
									tx.error ??
									new Error("session transaction aborted"),
							);
						read.onsuccess = () => {
							try {
								state = next(read.result);
								if (state === null) store.delete(key);
								else store.put(state, key);
							} catch (error) {
								updateError = error;
								tx.abort();
							}
						};
					});
				},
			});
		};
	});
}
