import type { Page } from "playwright";

export type Notice = { scope: string; generation: string; withdrawal: string };
export type GrantPage = Window & {
	grantGate?: Promise<() => void>;
	withdrawalNotice?: Promise<Notice>;
};

/** Hold the database open callback before the initializing tab reads its grant. */
export async function holdGrantOpen(page: Page) {
	await page.evaluate(() => {
		const open = IDBFactory.prototype.open;
		const success = Object.getOwnPropertyDescriptor(
			IDBRequest.prototype,
			"onsuccess",
		);
		if (!success?.set) throw new Error("IndexedDB open handler is unavailable");

		const gate = Promise.withResolvers<() => void>();
		(window as GrantPage).grantGate = gate.promise;
		IDBFactory.prototype.open = function (...args) {
			const request = open.apply(this, args);
			if (args[0] !== "liatris-delivery") return request;

			IDBFactory.prototype.open = open;
			Object.defineProperty(request, "onsuccess", {
				set(listener: (event: Event) => void) {
					success.set?.call(request, (event: Event) => {
						gate.resolve(() => listener.call(request, event));
					});
				},
			});
			return request;
		};
	});
}

/** Pause after the initial read or hold an aborted verification callback. */
export async function holdGrantTransaction(
	page: Page,
	stage: "read" | "verify" | "verify-error",
) {
	await page.evaluate((stage) => {
		const failVerification = stage === "verify-error";
		const position = stage === "read" ? 1 : 2;
		const transaction = IDBDatabase.prototype.transaction;
		const callback = failVerification ? "onabort" : "oncomplete";
		const handler = Object.getOwnPropertyDescriptor(
			IDBTransaction.prototype,
			callback,
		);
		if (!handler?.set)
			throw new Error("IndexedDB transaction handler is unavailable");

		const get = IDBObjectStore.prototype.get;
		const gate = Promise.withResolvers<() => void>();
		(window as GrantPage).grantGate = gate.promise;
		let reads = 0;

		IDBDatabase.prototype.transaction = function (...args) {
			const tx = transaction.apply(this, args);
			if (this.name !== "liatris-delivery" || ++reads !== position) return tx;

			IDBDatabase.prototype.transaction = transaction;
			Object.defineProperty(tx, callback, {
				set(listener: (event: Event) => void) {
					handler.set?.call(tx, (event: Event) => {
						gate.resolve(() => listener.call(tx, event));
					});
				},
			});
			if (failVerification) {
				IDBObjectStore.prototype.get = function (key) {
					const request = get.call(this, key);
					if (this.name === "scopes" && this.transaction === tx) {
						IDBObjectStore.prototype.get = get;
						request.addEventListener("success", () => tx.abort(), {
							once: true,
						});
					}
					return request;
				};
			}
			return tx;
		};
	}, stage);
}
