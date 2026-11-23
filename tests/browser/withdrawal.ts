import assert from "node:assert/strict";
import test from "node:test";
import { chromium, firefox, type Page, webkit } from "playwright";
import type { Envelope } from "../../src/records.ts";
import { openSearch, postedEvents, submission } from "./search-fixture.ts";

async function failQueueDeletion(page: Page) {
	await page.evaluate(() => {
		const getAllKeys = IDBIndex.prototype.getAllKeys;
		IDBIndex.prototype.getAllKeys = function (...args) {
			if (this.name === "scope")
				throw new DOMException(
					"simulated queue deletion failure",
					"UnknownError",
				);

			return getAllKeys.apply(this, args);
		};
	});
}

async function failWithdrawalWrite(page: Page, abortCommit: boolean) {
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

function pendingRecords(page: Page) {
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

function registerWithdrawalRecoveryTest(
	origin: string,
	engine: typeof chromium,
) {
	test(`${engine.name()} blocks replay after failed withdrawal and preserves a newer grant on retry`, {
		timeout: 30_000,
	}, async () => {
		const browser = await engine.launch();
		try {
			const context = await browser.newContext();
			const first = await context.newPage();
			const peer = await context.newPage();
			const search = await openSearch(peer, origin);
			await first.goto(origin);
			await first.locator("#consent:enabled").waitFor();
			const consent = first.getByRole("checkbox");
			await consent.focus();
			await first.keyboard.press("Space");
			await first.getByText("Collection enabled.", { exact: true }).waitFor();
			assert.equal(
				await consent.evaluate((box) => document.activeElement === box),
				true,
			);

			let offline = true;
			const delivered: Envelope[] = [];
			await context.route("**/api/ubi", async (route) => {
				if (offline) {
					await route.fulfill({
						status: 503,
						headers: { "retry-after": "60" },
					});
				} else {
					delivered.push(...postedEvents(route.request()));
					await route.continue();
				}
			});
			const sentOffline = peer.waitForResponse(
				(response) =>
					response.status() === 503 && !!submission(response.request()),
			);
			await search.click();
			const old = submission((await sentOffline).request());
			assert.ok(old);

			await failQueueDeletion(first);
			await first.keyboard.press("Space");
			await first.getByText("Could not complete withdrawal.").waitFor();
			assert.equal(
				await consent.evaluate((box) => document.activeElement === box),
				true,
			);
			await peer.getByText("Collection disabled.", { exact: true }).waitFor();
			assert.ok(
				(await pendingRecords(peer)).some(
					({ record }) => record.event_id === old.event_id,
				),
			);

			offline = false;
			await peer.reload();
			await failQueueDeletion(peer);
			await peer.evaluate(() => {
				const now = Date.now;
				Date.now = () => now() + 120_000;
			});
			await peer.getByRole("checkbox").click();
			await peer.getByText("Could not enable collection.").waitFor();
			assert.equal(await peer.getByRole("checkbox").isChecked(), false);
			assert.equal(delivered.length, 0);

			await peer.reload();
			await peer.getByRole("checkbox").check();
			await peer.getByText("Collection enabled.", { exact: true }).waitFor();
			assert.deepEqual(await pendingRecords(peer), []);

			// The original page can finish its retry even while its deletion path
			// is unavailable, because the peer has already removed the old queue.
			const retry = first.getByRole("button", { name: "Retry withdrawal" });
			await retry.focus();
			await first.keyboard.press("Space");
			await first.getByText("Collection disabled.", { exact: true }).waitFor();
			assert.equal(
				await consent.evaluate((box) => document.activeElement === box),
				true,
			);
			assert.equal(await retry.isVisible(), false);

			const accepted = peer.waitForResponse(
				(response) =>
					response.status() === 200 && !!submission(response.request()),
			);
			await search.click();
			const fresh = submission((await accepted).request());
			assert.ok(fresh);
			assert.notEqual(fresh.payload.session_id, old.payload.session_id);
			assert.ok(
				delivered.every(
					(event) => event.payload.query_id !== old.payload.query_id,
				),
			);
		} finally {
			await browser.close();
		}
	});
}

function registerWithdrawalWriteFailureTest(
	origin: string,
	engine: typeof chromium,
	regrantBeforeRetry: boolean,
) {
	const recovery = regrantBeforeRetry ? "peer regrant" : "withdrawal retry";
	test(`${engine.name()} stops peers after a failed withdrawal write and recovers through ${recovery}`, {
		timeout: 30_000,
	}, async () => {
		const browser = await engine.launch();
		try {
			const context = await browser.newContext();
			const first = await context.newPage();
			const peer = await context.newPage();
			const search = await openSearch(peer, origin);
			await first.goto(origin);
			const consent = first.getByRole("checkbox");
			await consent.check();
			await first.getByText("Collection enabled.", { exact: true }).waitFor();

			let offline = true;
			const posted: Envelope[] = [];
			await context.route("**/api/ubi", async (route) => {
				if (offline) {
					await route.fulfill({
						status: 503,
						headers: { "retry-after": "60" },
					});
				} else {
					posted.push(...postedEvents(route.request()));
					await route.continue();
				}
			});
			const deferred = peer.waitForResponse(
				(response) =>
					response.status() === 503 && !!submission(response.request()),
			);
			await search.click();
			const old = submission((await deferred).request());
			assert.ok(old);

			await failWithdrawalWrite(first, regrantBeforeRetry);
			await consent.uncheck();
			await first.getByText("Could not complete withdrawal.").waitFor();
			await peer.getByText("Collection disabled.", { exact: true }).waitFor();
			assert.equal(await peer.getByRole("checkbox").isChecked(), false);
			assert.ok(
				(await pendingRecords(peer)).some(
					({ record }) => record.event_id === old.event_id,
				),
			);

			offline = false;
			await peer.evaluate(() => {
				const now = Date.now;
				Date.now = () => now() + 120_000;
			});
			await search.click();
			await peer.getByText("no-consent", { exact: true }).waitFor();
			assert.equal(posted.length, 0);

			const regrant = async () => {
				await peer.getByRole("checkbox").check();
				await peer.getByText("Collection enabled.", { exact: true }).waitFor();
				assert.deepEqual(await pendingRecords(peer), []);
			};
			if (regrantBeforeRetry) await regrant();

			await first.getByRole("button", { name: "Retry withdrawal" }).click();
			await first.getByText("Collection disabled.", { exact: true }).waitFor();
			assert.deepEqual(await pendingRecords(peer), []);

			if (!regrantBeforeRetry) await regrant();

			const accepted = peer.waitForResponse(
				(response) =>
					response.status() === 200 && !!submission(response.request()),
			);
			await search.click();
			const fresh = submission((await accepted).request());
			assert.ok(fresh);
			assert.notEqual(fresh.payload.session_id, old.payload.session_id);
			assert.ok(
				posted.every(
					(event) => event.payload.query_id === fresh.payload.query_id,
				),
			);
		} finally {
			await browser.close();
		}
	});
}

export function registerWithdrawalTests(origin: string) {
	for (const engine of [chromium, firefox, webkit]) {
		registerWithdrawalRecoveryTest(origin, engine);
		registerWithdrawalWriteFailureTest(origin, engine, false);
		registerWithdrawalWriteFailureTest(origin, engine, true);
	}
}
