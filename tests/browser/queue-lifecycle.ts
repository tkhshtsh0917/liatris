import assert from "node:assert/strict";
import test from "node:test";
import { chromium, firefox, webkit } from "playwright";
import {
	type GrantPage,
	holdGrantOpen,
	holdGrantTransaction,
} from "./grant-fixture.ts";
import { openSearch, submission } from "./search-fixture.ts";
import { failWithdrawalWrite, pendingRecords } from "./withdrawal-fixture.ts";

const heldStages = ["open", "read", "verify"] as const;

export function registerQueueLifecycleTests(origin: string) {
	for (const engine of [chromium, firefox, webkit]) {
		test(`${engine.name()} waits for withdrawal and retry before closing a queue`, {
			timeout: 30_000,
		}, async () => {
			const browser = await engine.launch();
			try {
				for (const mode of [
					"collector",
					"rejected-prerequisite",
					"failed-write",
				] as const) {
					const failWrite = mode === "failed-write";
					const context = await browser.newContext();
					try {
						const withdrawing = await context.newPage();
						const peer = await context.newPage();
						await withdrawing.goto(origin);
						const fixture = await withdrawing.evaluateHandle(async () => {
							const { createCollector, ConsentWithdrawalError } = (await import(
								"/assets/src/collector.js" as string
							)) as typeof import("../../src/collector.ts");
							const { createQueuedDelivery } = (await import(
								"/assets/src/queued-delivery.js" as string
							)) as typeof import("../../src/queued-delivery.ts");
							const { profile, sha256: profileHash } = await (
								await fetch("/demo-config.json")
							).json();

							function setup() {
								const queue = createQueuedDelivery({
									profile,
									profileHash,
									async send() {},
								});
								return {
									queue,
									collector: createCollector({ profile, profileHash, queue }),
								};
							}

							const fixture = setup();
							await fixture.collector.setConsent(true);
							return { ...fixture, setup, ConsentWithdrawalError };
						});

						const search = await openSearch(peer, origin);
						await context.route("**/api/ubi", (route) =>
							route.fulfill({ status: 503, headers: { "retry-after": "60" } }),
						);
						const queued = peer.waitForResponse(
							(response) =>
								response.status() === 503 && !!submission(response.request()),
						);
						await search.click();
						const original = submission((await queued).request());
						assert.ok(original);

						if (failWrite) await failWithdrawalWrite(withdrawing, false);
						const result = await fixture.evaluate(
							({ queue, collector, ConsentWithdrawalError }, mode) => {
								const signal = collector.consentSignal;
								if (!signal)
									throw new Error("expected active consent before withdrawal");

								function readRetry(error: unknown) {
									if (error instanceof ConsentWithdrawalError && error.retry)
										return error.retry;
									throw error;
								}

								const withdrawal =
									mode === "rejected-prerequisite"
										? queue.revoke(
												Promise.reject(new Error("earlier work failed")),
											)
										: collector.setConsent(false);
								const done = withdrawal.catch(readRetry);
								const duplicate = queue
									.revoke(
										Promise.reject(new Error("duplicate prerequisite failed")),
									)
									.catch(readRetry);
								const closed = queue.close();
								if (closed !== queue.close())
									throw new Error("close must be idempotent");
								return Promise.all([done, duplicate, closed]).then(
									([retry, duplicateRetry]) => ({
										retry,
										duplicateRetry,
										aborted: signal.aborted,
									}),
								);
							},
							mode,
						);

						await peer.getByText("Collection disabled.").waitFor();
						assert.equal(result.aborted, true);
						assert.equal(!!result.retry, failWrite);
						assert.deepEqual(result.duplicateRetry, result.retry);
						if (result.retry) {
							assert.ok(
								(await pendingRecords(peer)).some(
									({ record }) => record.event_id === original.event_id,
								),
							);
							await fixture.evaluate(async ({ setup }, retry) => {
								const { queue } = setup();
								const cleanup = queue.retryWithdrawal(
									retry,
									Promise.reject(new Error("earlier retry work failed")),
								);
								await Promise.all([cleanup, queue.close()]);
							}, result.retry);
						}
						assert.deepEqual(await pendingRecords(peer), []);
					} finally {
						await context.close();
					}
				}
			} finally {
				await browser.close();
			}
		});

		test(`${engine.name()} keeps a closed queue inactive at every grant stage`, {
			timeout: 30_000,
		}, async () => {
			const browser = await engine.launch();
			try {
				const page = await browser.newPage();
				await page.goto(origin);
				for (const stage of heldStages) {
					if (stage === "open") await holdGrantOpen(page);
					else await holdGrantTransaction(page, stage);

					const result = await page.evaluate(async (stage) => {
						const { createCollector } = (await import(
							"/assets/src/collector.js" as string
						)) as typeof import("../../src/collector.ts");
						const { createQueuedDelivery } = (await import(
							"/assets/src/queued-delivery.js" as string
						)) as typeof import("../../src/queued-delivery.ts");
						const { profile, sha256: profileHash } = await (
							await fetch("/demo-config.json")
						).json();

						const sent: string[] = [];
						const queue = createQueuedDelivery({
							profile,
							profileHash,
							async send(event) {
								sent.push(event.event_id);
							},
						});
						const collector = createCollector({ profile, profileHash, queue });
						const grant = collector.setConsent(true).then(
							() => true,
							() => false,
						);
						const { grantGate } = window as GrantPage;
						if (!grantGate) throw new Error("grant gate is unavailable");
						const release = await grantGate;
						const closed = queue.close();
						if (stage === "open") release();
						await closed;
						if (stage !== "open") release();
						const completed = await grant;
						const newGrant = await collector.setConsent(true).then(
							() => true,
							() => false,
						);

						return {
							completed,
							newGrant,
							active: !!collector.consentSignal,
							tracked: await collector.trackEvent("search_submitted"),
							sent,
						};
					}, stage);
					assert.deepEqual(
						result,
						{
							completed: false,
							newGrant: false,
							active: false,
							tracked: "no-consent",
							sent: [],
						},
						stage,
					);
				}
			} finally {
				await browser.close();
			}
		});

		test(`${engine.name()} stops capture when the browser deletes the queue database`, {
			timeout: 30_000,
		}, async () => {
			const browser = await engine.launch();
			try {
				const page = await browser.newPage();
				const search = await openSearch(page, origin);
				const accepted = () =>
					page.waitForResponse(
						(response) => response.ok() && !!submission(response.request()),
					);
				const first = accepted();
				await search.click();
				const original = submission((await first).request());
				assert.ok(original);

				await page.evaluate(
					() =>
						new Promise<void>((resolve, reject) => {
							const deletion = indexedDB.deleteDatabase("liatris-delivery");
							deletion.onsuccess = () => resolve();
							deletion.onerror = () => reject(deletion.error);
						}),
				);
				await page.getByText("Collection disabled.").waitFor();
				assert.equal(await page.getByRole("checkbox").isChecked(), false);
				await search.click();
				await page.getByText("no-consent", { exact: true }).waitFor();

				await page.getByRole("checkbox").check();
				await page.getByText("Collection enabled.").waitFor();
				const second = accepted();
				await search.click();
				const fresh = submission((await second).request());
				assert.ok(fresh);
				assert.notEqual(fresh.payload.session_id, original.payload.session_id);
			} finally {
				await browser.close();
			}
		});

		test(`${engine.name()} requires a queue to finish its own failed withdrawal before granting again`, {
			timeout: 30_000,
		}, async () => {
			const browser = await engine.launch();
			try {
				const page = await browser.newPage();
				await page.goto(origin);
				await failWithdrawalWrite(page, false);
				const result = await page.evaluate(async () => {
					const { createCollector } = (await import(
						"/assets/src/collector.js" as string
					)) as typeof import("../../src/collector.ts");
					const { createQueuedDelivery, ConsentWithdrawalError } =
						(await import(
							"/assets/src/queued-delivery.js" as string
						)) as typeof import("../../src/queued-delivery.ts");
					const { profile, sha256: profileHash } = await (
						await fetch("/demo-config.json")
					).json();
					const queue = createQueuedDelivery({
						profile,
						profileHash,
						async send() {},
					});
					try {
						const collector = createCollector({ profile, profileHash, queue });
						const invalidRetry = await collector
							.retryConsentWithdrawal({
								scope: '["another","application"]',
								generation: null,
								marker: crypto.randomUUID(),
							})
							.then(
								() => false,
								(error) => error instanceof TypeError,
							);
						await collector.setConsent(true);
						const original = await queue.grant();
						const firstWithdrawal = queue.revoke().then(
							() => false,
							(error) =>
								error instanceof ConsentWithdrawalError && !!error.retry,
						);
						const premature = await queue.grant().then(
							() => true,
							() => false,
						);
						const failed = await firstWithdrawal;
						const afterFailure = await queue.grant().then(
							() => true,
							() => false,
						);
						await queue.revoke();
						const fresh = await queue.grant();
						return {
							invalidRetry,
							premature,
							failed,
							afterFailure,
							originalAborted: original.aborted,
							freshActive: !fresh.aborted,
						};
					} finally {
						await queue.close();
					}
				});
				assert.deepEqual(result, {
					invalidRetry: true,
					premature: false,
					failed: true,
					afterFailure: false,
					originalAborted: true,
					freshActive: true,
				});
			} finally {
				await browser.close();
			}
		});
	}
}
