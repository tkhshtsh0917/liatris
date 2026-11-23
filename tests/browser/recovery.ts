import assert from "node:assert/strict";
import test from "node:test";
import { chromium, firefox, webkit } from "playwright";
import type { Envelope } from "../../src/records.ts";
import { openSearch, postedEvents, submission } from "./search-fixture.ts";

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

	test("keeps result cards usable across consent changes and measures clicks only on fresh results", {
		timeout: 30_000,
	}, async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			const clicks: Envelope[] = [];
			page.on("request", (request) => {
				clicks.push(
					...postedEvents(request).filter(
						({ payload }) => payload.action_name === "click",
					),
				);
			});

			const search = await openSearch(page, origin);
			const consent = page.getByRole("checkbox");
			const result = page.getByRole("button", { name: "Garden spade" });
			const detail = page.getByRole("heading", { name: "Garden spade" });
			const close = page.getByRole("button", { name: "Close detail" });
			const initial = page.waitForResponse(
				(response) =>
					response.status() === 200 &&
					submission(response.request()) !== undefined,
			);
			await search.click();
			const firstQueryId = submission((await initial).request())?.payload
				.query_id;
			assert.ok(firstQueryId);

			await consent.uncheck();
			await page.getByText("Collection disabled.", { exact: true }).waitFor();
			await result.click();
			await detail.waitFor();
			await close.click();

			await consent.check();
			await page.getByText("Collection enabled.", { exact: true }).waitFor();
			await result.click();
			await detail.waitFor();
			await close.click();

			const fresh = page.waitForResponse((response) => {
				const event = submission(response.request());
				return (
					response.status() === 200 &&
					event !== undefined &&
					event.payload.query_id !== firstQueryId
				);
			});
			await search.click();
			const freshQueryId = submission((await fresh).request())?.payload
				.query_id;
			assert.ok(freshQueryId);
			const click = page.waitForResponse(
				(response) =>
					response.status() === 200 &&
					postedEvents(response.request()).some(
						({ payload }) =>
							payload.action_name === "click" &&
							payload.query_id === freshQueryId,
					),
			);
			await result.click();
			await click;
			assert.deepEqual(
				clicks.map(({ payload }) => payload.query_id),
				[freshQueryId],
			);
		} finally {
			await browser.close();
		}
	});

	test("upgrades v0.2.0 storage and preserves its session for the current SDK", {
		timeout: 30_000,
	}, async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.goto(origin);
			const expected = await page.evaluate(async () => {
				const scope = JSON.stringify(["sample", "storefront"]);
				const id = crypto.randomUUID();
				const now = Date.now();
				await new Promise<void>((resolve, reject) => {
					const request = indexedDB.open("liatris-delivery", 2);
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						request.result.close();
						resolve();
					};
					request.onupgradeneeded = () => {
						const db = request.result;
						db.createObjectStore("scopes").put(
							{
								generation: crypto.randomUUID(),
								session: {
									id,
									number: 4,
									startedAtMs: now - 1000,
									lastActivityMs: now,
								},
							},
							scope,
						);
						const outbox = db.createObjectStore("outbox", {
							keyPath: ["scope", "record.event_id"],
						});
						outbox.createIndex("scope", "scope");
						outbox.createIndex("expiry", ["scope", "expiresAt"]);
						outbox.createIndex("ready", [
							"scope",
							"record.profile_hash",
							"priority",
							"nextAttempt",
						]);
					};
				});
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
			const legacyOpen = await page.evaluate(
				() =>
					new Promise<string | undefined>((resolve) => {
						const request = indexedDB.open("liatris-delivery", 2);
						request.onerror = () => resolve(request.error?.name);
						request.onsuccess = () => {
							request.result.close();
							resolve(undefined);
						};
					}),
			);
			assert.equal(legacyOpen, "VersionError");
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
