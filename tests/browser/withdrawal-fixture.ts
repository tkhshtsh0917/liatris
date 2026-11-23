import type { Page } from "playwright";
import type { Envelope } from "../../src/records.ts";

export async function failWithdrawalWrite(page: Page, abortCommit: boolean) {
	await page.evaluate((abortCommit) => {
		const put = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (value, key) {
			if (this.name === "scopes" && value.cleanupPending) {
				IDBObjectStore.prototype.put = put;
				if (abortCommit) {
					const request = put.call(this, value, key);
					request.addEventListener(
						"success",
						() => request.transaction?.abort(),
						{
							once: true,
						},
					);
					return request;
				}
				throw new DOMException(
					"simulated withdrawal write failure",
					"QuotaExceededError",
				);
			}

			return put.call(this, value, key);
		};
	}, abortCommit);
}

export function pendingRecords(page: Page) {
	return page.evaluate(async () => {
		const { openOutbox } = (await import(
			"/assets/src/outbox-storage.js" as string
		)) as typeof import("../../src/outbox-storage.ts");
		const db = await openOutbox();
		try {
			return await new Promise<{ record: Envelope }[]>((resolve, reject) => {
				const request = db.transaction("outbox").objectStore("outbox").getAll();
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		} finally {
			db.close();
		}
	});
}
