import assert from "node:assert/strict";
import test from "node:test";
import {
	type BrowserContext,
	chromium,
	firefox,
	type Page,
	webkit,
} from "playwright";
import { openSearch, postedEvents, submission } from "./search-fixture.ts";
import { failWithdrawalWrite, pendingRecords } from "./withdrawal-fixture.ts";

type Notice = { scope: string; generation: string; withdrawal: string };
type GrantPage = Window & {
	grantGate?: Promise<() => void>;
	withdrawalNotice?: Promise<Notice>;
};

/** Hold the database open callback before the initializing tab reads its grant. */
async function holdGrantOpen(page: Page) {
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
async function holdGrantTransaction(page: Page, failVerification: boolean) {
	await page.evaluate((failVerification) => {
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
			if (
				this.name !== "liatris-delivery" ||
				++reads !== (failVerification ? 2 : 1)
			)
				return tx;

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
	}, failVerification);
}

async function observeWithdrawal(page: Page) {
	await page.evaluate(() => {
		const target = window as GrantPage;
		// Register after the SDK has subscribed, so it receives the notice first.
		const result = Promise.withResolvers<Notice>();
		target.withdrawalNotice = result.promise;
		const channel = new BroadcastChannel("liatris-consent");
		channel.onmessage = ({ data }) => {
			channel.close();
			result.resolve(data);
		};
	});
}

async function beginHeldGrant(page: Page) {
	await page.getByRole("checkbox").click();
	await page.evaluate(async () => {
		const { grantGate } = window as GrantPage;
		if (!grantGate) throw new Error("grant gate is unavailable");
		await grantGate;
	});
	await observeWithdrawal(page);
}

function releaseAfterWithdrawal(page: Page) {
	return page.evaluate(async () => {
		const target = window as GrantPage;
		if (!target.grantGate || !target.withdrawalNotice)
			throw new Error("grant gate or withdrawal notice is unavailable");

		const notice = await target.withdrawalNotice;
		(await target.grantGate)();
		return notice;
	});
}

function searchButton(page: Page) {
	return page.getByRole("button", { name: "Search", exact: true });
}

async function queueSearch(context: BrowserContext, page: Page) {
	await context.route("**/api/ubi", (route) =>
		route.fulfill({ status: 503, headers: { "retry-after": "60" } }),
	);
	try {
		const waiting = page.waitForResponse(
			(response) =>
				response.status() === 503 && !!submission(response.request()),
		);
		await searchButton(page).click();
		const old = submission((await waiting).request());
		assert.ok(old);
		return old;
	} finally {
		await context.unroute("**/api/ubi");
	}
}

async function assertFreshGrant(page: Page, withdrawnEventId: string) {
	const sent: string[] = [];
	page.on("request", (request) => {
		sent.push(...postedEvents(request).map(({ event_id }) => event_id));
	});
	await page.evaluate(() => {
		const now = Date.now;
		Date.now = () => now() + 120_000;
	});
	await page.getByRole("checkbox").check();
	await page.getByText("Collection enabled.").waitFor();
	assert.deepEqual(await pendingRecords(page), []);

	const accepted = page.waitForResponse(
		(response) => response.ok() && !!submission(response.request()),
	);
	await searchButton(page).click();
	await accepted;
	assert.equal(sent.includes(withdrawnEventId), false);
}

export function registerGrantWithdrawalTests(origin: string) {
	for (const engine of [chromium, firefox, webkit]) {
		test(`${engine.name()} rejects a pending grant that reads storage after withdrawal`, {
			timeout: 30_000,
		}, async () => {
			const browser = await engine.launch();
			try {
				const context = await browser.newContext();
				const first = await context.newPage();
				const starting = await context.newPage();
				await openSearch(first, origin);
				await starting.goto(origin);
				await holdGrantOpen(starting);
				await beginHeldGrant(starting);

				await first.getByRole("checkbox").uncheck();
				await first.getByText("Collection disabled.").waitFor();
				const notice = await releaseAfterWithdrawal(starting);
				assert.ok(notice.generation);
				await starting.getByText("Could not enable collection.").waitFor();
				assert.equal(await starting.getByRole("checkbox").isChecked(), false);
				await searchButton(starting).click();
				await starting.getByText("no-consent", { exact: true }).waitFor();

				assert.ok(notice.withdrawal);
				await holdGrantTransaction(starting, false);
				await beginHeldGrant(starting);
				await first.evaluate((notice) => {
					const channel = new BroadcastChannel("liatris-consent");
					channel.postMessage(notice);
					channel.close();
				}, notice);
				assert.deepEqual(await releaseAfterWithdrawal(starting), notice);
				await starting.getByText("Collection enabled.").waitFor();
			} finally {
				await browser.close();
			}
		});

		test(`${engine.name()} retains the withdrawal notice after grant verification fails`, {
			timeout: 30_000,
		}, async () => {
			const browser = await engine.launch();
			try {
				const context = await browser.newContext();
				const first = await context.newPage();
				const starting = await context.newPage();
				await openSearch(first, origin);
				await starting.goto(origin);
				const old = await queueSearch(context, first);

				await holdGrantTransaction(starting, true);
				await beginHeldGrant(starting);
				await failWithdrawalWrite(first, false);
				await first.getByRole("checkbox").uncheck();
				await first.getByText("Could not complete withdrawal.").waitFor();
				assert.ok((await releaseAfterWithdrawal(starting)).generation);
				await starting.getByText("Could not enable collection.").waitFor();
				assert.ok(
					(await pendingRecords(starting)).some(
						({ record }) => record.event_id === old.event_id,
					),
				);
				await assertFreshGrant(starting, old.event_id);
			} finally {
				await browser.close();
			}
		});

		test(`${engine.name()} keeps withdrawal received while inactive for the next grant`, {
			timeout: 30_000,
		}, async () => {
			const browser = await engine.launch();
			try {
				const context = await browser.newContext();
				const first = await context.newPage();
				const idle = await context.newPage();
				await openSearch(idle, origin);
				await idle.getByRole("checkbox").uncheck();
				await idle.getByText("Collection disabled.").waitFor();
				await openSearch(first, origin);
				const old = await queueSearch(context, first);

				await observeWithdrawal(idle);
				await failWithdrawalWrite(first, false);
				await first.getByRole("checkbox").uncheck();
				await first.getByText("Could not complete withdrawal.").waitFor();
				await idle.evaluate(async () => {
					const { withdrawalNotice } = window as GrantPage;
					if (!withdrawalNotice)
						throw new Error("withdrawal notice is unavailable");
					await withdrawalNotice;
				});

				assert.ok(
					(await pendingRecords(idle)).some(
						({ record }) => record.event_id === old.event_id,
					),
				);
				await assertFreshGrant(idle, old.event_id);
			} finally {
				await browser.close();
			}
		});
	}
}
