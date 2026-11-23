import assert from "node:assert/strict";
import test from "node:test";
import {
	type BrowserContext,
	chromium,
	firefox,
	type Page,
	webkit,
} from "playwright";
import {
	type GrantPage,
	holdGrantOpen,
	holdGrantTransaction,
	type Notice,
} from "./grant-fixture.ts";
import { openSearch, postedEvents, submission } from "./search-fixture.ts";
import { failWithdrawalWrite, pendingRecords } from "./withdrawal-fixture.ts";

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
	await waitForGrantGate(page);
	await observeWithdrawal(page);
}

async function waitForGrantGate(page: Page) {
	await page.evaluate(async () => {
		const { grantGate } = window as GrantPage;
		if (!grantGate) throw new Error("grant gate is unavailable");
		await grantGate;
	});
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
				await holdGrantTransaction(starting, "read");
				await beginHeldGrant(starting);
				await first.evaluate((notice) => {
					const channel = new BroadcastChannel("liatris-consent");
					channel.postMessage(notice);
					channel.close();
				}, notice);
				assert.deepEqual(await releaseAfterWithdrawal(starting), notice);
				await starting.getByText("Collection enabled.").waitFor();

				const sent = starting.waitForResponse(
					(response) => response.ok() && !!submission(response.request()),
				);
				await searchButton(starting).click();
				await sent;

				// Deduplication must survive a session write and another withdrawal.
				await starting.getByRole("checkbox").uncheck();
				await starting.getByText("Collection disabled.").waitFor();
				await holdGrantTransaction(starting, "verify");
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

				await holdGrantTransaction(starting, "verify-error");
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

		test(`${engine.name()} preserves a newer grant when an earlier withdrawal is delayed`, {
			timeout: 30_000,
		}, async () => {
			const browser = await engine.launch();
			try {
				const context = await browser.newContext();
				const first = await context.newPage();
				const peer = await context.newPage();
				await openSearch(first, origin);
				await openSearch(peer, origin);

				// The session transaction commits, but its callback delays the
				// withdrawal queued behind it by the host's collector.
				await holdGrantTransaction(first, "read");
				await searchButton(first).click();
				await waitForGrantGate(first);
				await first.getByRole("checkbox").uncheck();
				await peer.getByRole("checkbox").uncheck();
				await peer.getByText("Collection disabled.").waitFor();
				await peer.getByRole("checkbox").check();
				await peer.getByText("Collection enabled.").waitFor();
				const fresh = await queueSearch(context, peer);

				await first.evaluate(async () => {
					const { grantGate } = window as GrantPage;
					if (!grantGate) throw new Error("grant gate is unavailable");
					(await grantGate)();
				});
				await first.getByText("Collection disabled.").waitFor();
				assert.equal(await peer.getByRole("checkbox").isChecked(), true);
				assert.ok(
					(await pendingRecords(peer)).some(
						({ record }) => record.event_id === fresh.event_id,
					),
				);
			} finally {
				await browser.close();
			}
		});
	}
}
