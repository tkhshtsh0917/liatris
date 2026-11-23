import assert from "node:assert/strict";
import test from "node:test";
import { chromium, firefox, type Page, webkit } from "playwright";
import type { Envelope } from "../../src/records.ts";
import { openSearch, postedEvents, submission } from "./search-fixture.ts";
import { failWithdrawalWrite, pendingRecords } from "./withdrawal-fixture.ts";

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

async function failWithdrawalRead(page: Page) {
	await page.evaluate(() => {
		const get = IDBObjectStore.prototype.get;
		IDBObjectStore.prototype.get = function (key) {
			if (this.name === "scopes") {
				IDBObjectStore.prototype.get = get;
				throw new DOMException("simulated scope read failure", "UnknownError");
			}
			return get.call(this, key);
		};
	});
}

/** Holds the grant's first completion callback after its real transaction commits. */
async function holdGrantCompletion(page: Page) {
	await page.evaluate(() => {
		const transaction = IDBDatabase.prototype.transaction;
		const complete = Object.getOwnPropertyDescriptor(
			IDBTransaction.prototype,
			"oncomplete",
		);
		if (!complete?.set)
			throw new Error("IndexedDB completion handler is unavailable");

		const hold = Promise.withResolvers<() => void>();
		Object.assign(window, { heldGrant: hold.promise });
		IDBDatabase.prototype.transaction = function (...args) {
			const tx = transaction.apply(this, args);
			if (this.name !== "liatris-delivery") return tx;

			IDBDatabase.prototype.transaction = transaction;
			Object.defineProperty(tx, "oncomplete", {
				set(listener: (event: Event) => void) {
					complete.set?.call(tx, (event: Event) => {
						hold.resolve(() => listener.call(tx, event));
					});
				},
			});
			return tx;
		};
		const notified = Promise.withResolvers<void>();
		Object.assign(window, { withdrawalNotified: notified.promise });
		const channel = new BroadcastChannel("liatris-consent");
		channel.onmessage = () => {
			channel.close();
			setTimeout(notified.resolve, 0);
		};
	});
}

function registerWithdrawalDuringGrantTest(
	origin: string,
	engine: typeof chromium,
) {
	test(`${engine.name()} stops active and initializing peers when withdrawal cannot read IndexedDB`, {
		timeout: 30_000,
	}, async () => {
		const browser = await engine.launch();
		try {
			const context = await browser.newContext();
			const first = await context.newPage();
			const peer = await context.newPage();
			const starting = await context.newPage();
			await openSearch(first, origin);
			const peerSearch = await openSearch(peer, origin);
			await starting.goto(origin);
			await holdGrantCompletion(starting);
			await starting.getByRole("checkbox").click();
			await starting.evaluate(async () => {
				const { heldGrant } = window as Window & {
					heldGrant?: Promise<() => void>;
				};
				if (!heldGrant) throw new Error("grant gate is unavailable");
				await heldGrant;
			});

			await context.route("**/api/ubi", (route) =>
				route.fulfill({ status: 503, headers: { "retry-after": "60" } }),
			);
			const sentOffline = peer.waitForResponse(
				(response) =>
					response.status() === 503 && !!submission(response.request()),
			);
			await peerSearch.click();
			const old = submission((await sentOffline).request());
			assert.ok(old);

			await failWithdrawalRead(first);
			await first.getByRole("checkbox").uncheck();
			await first.getByText("Could not complete withdrawal.").waitFor();
			await peer.getByText("Collection disabled.", { exact: true }).waitFor();
			await starting.evaluate(async () => {
				const page = window as Window & {
					heldGrant?: Promise<() => void>;
					withdrawalNotified?: Promise<void>;
				};
				if (!page.heldGrant || !page.withdrawalNotified)
					throw new Error(
						"grant gate or withdrawal notification is unavailable",
					);
				await page.withdrawalNotified;
				(await page.heldGrant)();
			});
			await starting.getByText("Could not enable collection.").waitFor();
			assert.equal(await starting.getByRole("checkbox").isChecked(), false);
			assert.ok(
				(await pendingRecords(peer)).some(
					({ record }) => record.event_id === old.event_id,
				),
			);

			await first.reload();
			await first.locator("#consent:enabled:not([aria-disabled])").waitFor();
			assert.deepEqual(await pendingRecords(peer), []);
			await peerSearch.click();
			await peer.getByText("no-consent", { exact: true }).waitFor();
		} finally {
			await browser.close();
		}
	});
}

function registerWithdrawalRecoveryTest(
	origin: string,
	engine: typeof chromium,
) {
	test(`${engine.name()} blocks replay after failed withdrawal and preserves a newer grant on reload and retry`, {
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

			// Keep a new event pending while the original page reloads and retries
			// the saved withdrawal. Its retry must leave the new queue alone.
			offline = true;
			const queuedAfterRegrant = peer.waitForResponse(
				(response) =>
					response.status() === 503 && !!submission(response.request()),
			);
			await search.click();
			const queued = submission((await queuedAfterRegrant).request());
			assert.ok(queued);
			await first.reload();
			await first.locator("#consent:enabled:not([aria-disabled])").waitFor();
			await first.getByText("Collection disabled.", { exact: true }).waitFor();
			assert.ok(
				(await pendingRecords(peer)).some(
					({ record }) => record.event_id === queued.event_id,
				),
			);
			await peer.getByText("Collection enabled.", { exact: true }).waitFor();
			offline = false;

			const accepted = peer.waitForResponse(
				(response) =>
					response.status() === 200 &&
					postedEvents(response.request()).some(
						(event) => event.event_id === queued.event_id,
					),
			);
			await peer.evaluate(() => {
				const now = Date.now;
				Date.now = () => now() + 120_000;
			});
			await search.click();
			await accepted;
			assert.notEqual(queued.payload.session_id, old.payload.session_id);
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

			const retry = first.getByRole("button", { name: "Retry withdrawal" });
			await retry.focus();
			await first.keyboard.press("Space");
			await first.getByText("Collection disabled.", { exact: true }).waitFor();
			assert.equal(
				await consent.evaluate((box) => document.activeElement === box),
				true,
			);
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
		registerWithdrawalDuringGrantTest(origin, engine);
		registerWithdrawalRecoveryTest(origin, engine);
		registerWithdrawalWriteFailureTest(origin, engine, false);
		registerWithdrawalWriteFailureTest(origin, engine, true);
	}
}
