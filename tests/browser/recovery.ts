import assert from "node:assert/strict";
import test from "node:test";
import { chromium, firefox, type Page, type Request, webkit } from "playwright";
import type { Envelope } from "../../src/records.ts";

function submission(request: Request) {
	if (!request.url().endsWith("/api/ubi") || request.method() !== "POST")
		return;

	const events = request.postDataJSON() as Envelope[];
	return events.find(
		({ payload }) => payload.action_name === "search_submitted",
	);
}

async function openSearch(page: Page, origin: string) {
	await page.goto(origin);
	await page.getByRole("checkbox").check();
	await page.getByText("Collection enabled.", { exact: true }).waitFor();
	return page.getByRole("button", { name: "Search", exact: true });
}

export function registerRecoveryTests(origin: string) {
	for (const engine of [chromium, firefox, webkit]) {
		test(`${engine.name()} retries the same event after throttling`, {
			timeout: 30_000,
		}, async () => {
			const browser = await engine.launch();
			try {
				const page = await browser.newPage();
				const search = await openSearch(page, origin);
				let original: Envelope | undefined;
				let refusedAt = 0;
				let elapsed = 0;
				await page.route("**/api/ubi", async (route) => {
					const event = submission(route.request());
					if (event && !original) {
						original = event;
						refusedAt = performance.now();
						await route.fulfill({
							status: 429,
							headers: { "retry-after": "1" },
						});
						return;
					}
					if (event && event.event_id === original?.event_id)
						elapsed = performance.now() - refusedAt;
					await route.continue();
				});

				const accepted = page.waitForResponse(
					(response) =>
						response.status() === 200 &&
						submission(response.request()) !== undefined,
				);
				await search.click();
				const response = await accepted;
				assert.ok(original);
				assert.deepEqual(submission(response.request()), original);
				assert.ok(elapsed >= 950, `retry began after only ${elapsed} ms`);
			} finally {
				await browser.close();
			}
		});
	}

	test("reuses a session saved by the v0.2.0 storage format", {
		timeout: 30_000,
	}, async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.goto(origin);
			const expected = await page.evaluate(async () => {
				const { openOutbox, updateOutbox } = (await import(
					"/assets/src/outbox-storage.js" as string
				)) as typeof import("../../src/outbox-storage.ts");
				const db = await openOutbox();
				const scope = JSON.stringify(["sample", "storefront"]);
				const id = crypto.randomUUID();
				const now = Date.now();
				try {
					await updateOutbox(db, scope, (_state, outbox) => {
						outbox.setConsent({
							generation: crypto.randomUUID(),
							session: {
								id,
								number: 4,
								startedAtMs: now - 1000,
								lastActivityMs: now,
							},
						});
					});
				} finally {
					db.close();
				}
				return id;
			});
			await page.getByRole("checkbox").check();
			await page.getByText("Collection enabled.", { exact: true }).waitFor();
			const receipt = page.waitForResponse(
				(response) =>
					response.status() === 200 &&
					submission(response.request()) !== undefined,
			);
			await page.getByRole("button", { name: "Search", exact: true }).click();
			assert.equal(
				submission((await receipt).request())?.payload.session_id,
				expected,
			);
		} finally {
			await browser.close();
		}
	});

	test("queues the first event offline and retries after connectivity returns", {
		timeout: 30_000,
	}, async () => {
		const browser = await chromium.launch();
		try {
			const context = await browser.newContext();
			const page = await context.newPage();
			const search = await openSearch(page, origin);
			await context.setOffline(true);

			const failed = page.waitForEvent("requestfailed", {
				predicate: (request) => submission(request) !== undefined,
				timeout: 8_000,
			});
			await search.click();
			const original = submission(await failed);
			assert.ok(original);
			const accepted = page.waitForResponse(
				(response) =>
					response.status() === 200 &&
					submission(response.request())?.event_id === original.event_id,
			);
			await context.setOffline(false);
			assert.deepEqual(submission((await accepted).request()), original);
		} finally {
			await browser.close();
		}
	});

	test("recovers on visibility change and reports a failed storage write to the caller", {
		timeout: 30_000,
	}, async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.goto(origin);
			const result = await page.evaluate(async () => {
				const [{ createQueuedDelivery }, { HttpDeliveryError }] =
					await Promise.all([
						import("/assets/src/queued-delivery.js" as string) as Promise<
							typeof import("../../src/queued-delivery.ts")
						>,
						import("/assets/src/http-delivery.js" as string) as Promise<
							typeof import("../../src/http-delivery.ts")
						>,
					]);
				const received = Promise.withResolvers<Envelope>();
				const record: Envelope = {
					event_id: crypto.randomUUID(),
					profile_hash: "recovery",
					kind: "event",
					payload: { action_name: "click" },
				};
				const queue = createQueuedDelivery({
					profile: { tenant: "test", application: "recovery" },
					profileHash: record.profile_hash,
					async send(event) {
						received.resolve(event);
					},
				});
				const signal = await queue.grant();
				const put = IDBObjectStore.prototype.put;

				// Simulate a failed outbox write at the storage boundary.
				IDBObjectStore.prototype.put = function (value, key) {
					if (this.name === "outbox")
						throw new DOMException(
							"simulated quota exhaustion",
							"QuotaExceededError",
						);
					return put.call(this, value, key);
				};
				let failure: string | undefined;
				try {
					await queue.enqueue(record, signal);
				} catch (error) {
					if (error instanceof DOMException) failure = error.name;
					else throw error;
				} finally {
					IDBObjectStore.prototype.put = put;
				}

				await queue.enqueue(record, signal);
				const afterQuota = await received.promise;
				await queue.close();

				const ready = Promise.withResolvers<void>();
				const recovered = Promise.withResolvers<Envelope>();
				IDBObjectStore.prototype.put = function (value, key) {
					if (this.name === "outbox" && value.attempts === 1) {
						this.transaction.addEventListener(
							"complete",
							() => ready.resolve(),
							{ once: true },
						);
					}
					return put.call(this, value, key);
				};
				const delayed = createQueuedDelivery({
					profile: { tenant: "test", application: "visibility" },
					profileHash: record.profile_hash,
					async send(event) {
						if (document.visibilityState === "hidden")
							throw new HttpDeliveryError(429, "60");
						recovered.resolve(event);
					},
				});
				const resumed = await delayed.grant();
				let visibility: DocumentVisibilityState = "hidden";
				Object.defineProperty(document, "visibilityState", {
					get: () => visibility,
				});
				delayed.resume();
				await delayed.enqueue(record, resumed);
				await ready.promise;
				IDBObjectStore.prototype.put = put;

				// The due time has passed while the background tab's timer was paused.
				const now = Date.now;
				Date.now = () => now() + 61_000;
				visibility = "visible";
				document.dispatchEvent(new Event("visibilitychange"));
				const delivered = await recovered.promise;
				Date.now = now;
				await delayed.close();
				return { failure, afterQuota, delivered, record };
			});
			assert.equal(result.failure, "QuotaExceededError");
			assert.deepEqual(result.afterQuota, result.record);
			assert.deepEqual(result.delivered, result.record);
		} finally {
			await browser.close();
		}
	});
}
