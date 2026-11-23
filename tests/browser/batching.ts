import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import type { Envelope } from "../../src/records.ts";

export function registerBatchingTests(origin: string) {
	test("groups concurrent queue writes while isolating cancelled and oversized events", {
		timeout: 30_000,
	}, async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.goto(origin);
			const result = await page.evaluate(async () => {
				const { createQueuedDelivery } = (await import(
					"/assets/src/queued-delivery.js" as string
				)) as typeof import("../../src/queued-delivery.ts");
				const queue = createQueuedDelivery({
					profile: { tenant: "test", application: "grouped" },
					profileHash: "grouped",
					async sendBatch(records) {
						return records.map(({ event_id }) => ({
							event_id,
							status: "retry",
						}));
					},
				});
				const signal = await queue.grant();
				const group = new Set<IDBTransaction>();
				const put = IDBObjectStore.prototype.put;
				IDBObjectStore.prototype.put = function (value, key) {
					if (this.name === "outbox" && value.attempts === 0)
						group.add(this.transaction);
					return put.call(this, value, key);
				};

				const event = (sample?: string): Envelope => ({
					event_id: crypto.randomUUID(),
					profile_hash: "grouped",
					kind: "event",
					payload: { action_name: "click", sample },
				});
				try {
					const cancelled = new AbortController();
					const writes = [
						...Array.from({ length: 40 }, () => queue.enqueue(event(), signal)),
						queue.enqueue(event(), cancelled.signal),
						queue.enqueue(event("あ".repeat(11_000)), signal),
					];
					cancelled.abort();
					const statuses = await Promise.allSettled(writes);
					return {
						transactions: group.size,
						committed: statuses.filter(({ status }) => status === "fulfilled")
							.length,
						errors: statuses.flatMap((status) =>
							status.status === "rejected" ? [String(status.reason)] : [],
						),
					};
				} finally {
					IDBObjectStore.prototype.put = put;
					await queue.close();
				}
			});
			assert.equal(result.committed, 40);
			assert.equal(result.transactions, 2);
			assert.deepEqual(result.errors, [
				"Error: collection consent was withdrawn",
				"RangeError: collection record is too large",
			]);
		} finally {
			await browser.close();
		}
	});

	test("coalesces session updates without rebinding observations to later events", {
		timeout: 30_000,
	}, async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.goto(origin);
			const result = await page.evaluate(async () => {
				const [{ createCollector }, { createQueuedDelivery }] =
					await Promise.all([
						import("/assets/src/collector.js" as string) as Promise<
							typeof import("../../src/collector.ts")
						>,
						import("/assets/src/queued-delivery.js" as string) as Promise<
							typeof import("../../src/queued-delivery.ts")
						>,
					]);
				const { profile, sha256 } = await (
					await fetch("/demo-config.json")
				).json();
				const queue = createQueuedDelivery({
					profile,
					profileHash: sha256,
					async sendBatch(events) {
						return events.map(({ event_id }) => ({
							event_id,
							status: "accepted",
						}));
					},
				});
				const collector = createCollector({
					profile,
					profileHash: sha256,
					queue,
					async loadWasm() {
						return (await fetch("/session.wasm")).arrayBuffer();
					},
				});
				await collector.setConsent(true);
				const put = IDBObjectStore.prototype.put;
				let writes = 0;
				IDBObjectStore.prototype.put = function (value, key) {
					if (this.name === "scopes" && value.session) writes++;
					return put.call(this, value, key);
				};
				const clock = Date.now;
				const firstAt = clock();
				const laterAt = firstAt + 31 * 60_000;
				try {
					Date.now = () => firstAt;
					const first = collector.trackEvent("add_cart");
					const bound = collector.bindObservation();
					Date.now = () => laterAt;
					const later = collector.trackEventWithObservation("add_cart");
					await Promise.all([first, later.delivery]);
					return {
						writes,
						firstMs: await bound?.sessionElapsedMs(laterAt),
						laterMs: await later.observation?.sessionElapsedMs(laterAt),
					};
				} finally {
					Date.now = clock;
					IDBObjectStore.prototype.put = put;
					await queue.close();
				}
			});
			assert.deepEqual(result, { writes: 1, firstMs: 31 * 60_000, laterMs: 0 });
		} finally {
			await browser.close();
		}
	});

	test("opts into two disjoint requests and aborts both on consent withdrawal", {
		timeout: 30_000,
	}, async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.goto(origin);
			const measured = await page.evaluate(async () => {
				const { createQueuedDelivery } = (await import(
					"/assets/src/queued-delivery.js" as string
				)) as typeof import("../../src/queued-delivery.ts");
				const twoStarted = Promise.withResolvers<void>();
				const twoAborted = Promise.withResolvers<void>();
				const ids: string[] = [];
				let started = 0;
				let aborted = 0;
				const queue = createQueuedDelivery({
					profile: { tenant: "test", application: "parallel" },
					profileHash: "parallel",
					parallelBatches: 2,
					async sendBatch(records, signal) {
						ids.push(...records.map(({ event_id }) => event_id));
						if (++started === 2) twoStarted.resolve();
						await new Promise<void>((resolve) => {
							signal.addEventListener(
								"abort",
								() => {
									if (++aborted === 2) twoAborted.resolve();
									resolve();
								},
								{ once: true },
							);
						});
						return records.map(({ event_id }) => ({
							event_id,
							status: "accepted",
						}));
					},
				});
				const consent = await queue.grant();
				await Promise.all(
					Array.from({ length: 96 }, () =>
						queue.enqueue(
							{
								event_id: crypto.randomUUID(),
								profile_hash: "parallel",
								kind: "event",
								payload: { action_name: "result_impression" },
							},
							consent,
						),
					),
				);
				await twoStarted.promise;
				await queue.revoke();
				await twoAborted.promise;
				await queue.close();
				return {
					started,
					aborted,
					count: ids.length,
					unique: new Set(ids).size,
				};
			});
			assert.deepEqual(measured, {
				started: 2,
				aborted: 2,
				count: 64,
				unique: 64,
			});
		} finally {
			await browser.close();
		}
	});
}
