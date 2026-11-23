import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { after, before } from "node:test";
import { chromium, firefox, type Page, type Request, webkit } from "playwright";
import { openEventStore } from "../../server/event-store.ts";
import type { Envelope } from "../../src/records.ts";
import { registerImpressionTests } from "./impressions.ts";
import { registerRecoveryTests } from "./recovery.ts";

const port = process.env.LIATRIS_BROWSER_TEST_PORT ?? "42881";
const origin = `http://127.0.0.1:${port}`;
const directory = await mkdtemp(join(tmpdir(), "liatris-browser-"));
const database = join(directory, "intake.sqlite");
const server = spawn(process.execPath, ["demo/server.ts"], {
	env: { ...process.env, LIATRIS_DEMO_PORT: port, LIATRIS_DB: database },
	stdio: ["ignore", "pipe", "inherit"],
});

before(async () => {
	const lines = createInterface({ input: server.stdout });
	const listening = Promise.withResolvers<void>();
	lines.on("line", (line) => {
		if (line === origin) listening.resolve();
	});
	await Promise.race([
		listening.promise,
		once(server, "exit").then(([code]) => {
			throw new Error(`demo server exited (${code})`);
		}),
	]);
});

after(async () => {
	if (server.exitCode === null && server.signalCode === null) {
		const stopped = once(server, "exit");
		server.kill();
		await stopped;
	}
	await rm(directory, { recursive: true });
});

function search(page: Page) {
	return page.getByRole("button", { name: "Search", exact: true }).click();
}

async function grant(page: Page) {
	await page.getByRole("checkbox").check();
	await page.getByText("Collection enabled.", { exact: true }).waitFor();
}

async function revoke(page: Page) {
	await page.getByRole("checkbox").uncheck();
	await page.getByText("Collection disabled.", { exact: true }).waitFor();
}

function postedEvents(request: Request) {
	return request.postDataJSON() as Envelope[];
}

function isSubmission(record: Envelope) {
	return record.payload.action_name === "search_submitted";
}

for (const engine of [chromium, firefox, webkit]) {
	test(`${engine.name()} resumes a committed event after reload and an acknowledgement loss`, {
		timeout: 30_000,
	}, async () => {
		const browser = await engine.launch();
		try {
			const context = await browser.newContext();
			const page = await context.newPage();
			const committed = Promise.withResolvers<Envelope>();
			let loseAcknowledgement = true;

			await context.route("**/api/ubi", async (route) => {
				const records = postedEvents(route.request());
				const record = records.find(isSubmission);
				if (!loseAcknowledgement) return route.continue();
				if (record) {
					const response = await route.fetch();
					assert.equal(response.status(), 200);
					assert.ok(
						(await response.json()).some(
							(item: { event_id: string; status: string }) =>
								item.event_id === record.event_id && item.status === "accepted",
						),
					);
					committed.resolve(record);
				}
				await route.abort();
			});
			await page.goto(origin);
			await grant(page);
			await search(page);
			const original = await committed.promise;

			await page.reload();
			loseAcknowledgement = false;
			const retried = page.waitForResponse(
				(response) =>
					response.url().endsWith("/api/ubi") &&
					postedEvents(response.request()).some(
						({ event_id }) => event_id === original.event_id,
					),
			);
			await grant(page);
			const receipt = await retried;
			assert.equal(receipt.status(), 200);
			assert.deepEqual(
				postedEvents(receipt.request()).find(
					({ event_id }) => event_id === original.event_id,
				),
				original,
			);

			const store = openEventStore(database, {
				tenant: "sample",
				application: "storefront",
			});
			try {
				assert.equal(
					store
						.pending(100)
						.filter((record) => record.event_id === original.event_id).length,
					1,
				);
			} finally {
				store.close();
			}
		} finally {
			await browser.close();
		}
	});

	test(`${engine.name()} discards pending events and disallows another tab after revocation`, {
		timeout: 30_000,
	}, async () => {
		const browser = await engine.launch();
		try {
			const context = await browser.newContext();
			const first = await context.newPage();
			const peer = await context.newPage();
			const delayed = Promise.withResolvers<Envelope>();
			const afterWithdrawal: Envelope[] = [];
			let offline = true;

			await context.route("**/api/ubi", async (route) => {
				const records = postedEvents(route.request());
				const record = records.find(isSubmission);
				if (offline) {
					await route.fulfill({
						status: 503,
						headers: { "retry-after": "60" },
					});
					if (record) delayed.resolve(record);
				} else {
					afterWithdrawal.push(...records);
					await route.continue();
				}
			});
			await first.goto(origin);
			await peer.goto(origin);
			await grant(first);
			await grant(peer);
			await search(peer);
			const original = await delayed.promise;

			await revoke(first);
			await search(peer);
			await peer.getByText("no-consent", { exact: true }).waitFor();
			const remaining = await peer.evaluate(
				() =>
					new Promise<number>((resolve, reject) => {
						const open = indexedDB.open("liatris-delivery");
						open.onerror = () => reject(open.error);
						open.onsuccess = () => {
							const tx = open.result.transaction("outbox");
							const count = tx.objectStore("outbox").count();
							count.onsuccess = () => resolve(count.result);
							count.onerror = () => reject(count.error);
							tx.oncomplete = () => open.result.close();
						};
					}),
			);
			assert.equal(remaining, 0);
			offline = false;
			await revoke(peer);
			await grant(peer);

			const posted = peer.waitForResponse(
				(response) =>
					response.url().endsWith("/api/ubi") &&
					postedEvents(response.request()).some(isSubmission),
			);
			await search(peer);
			const newResponse = await posted;
			const current = postedEvents(newResponse.request()).find(isSubmission);
			assert.ok(current);
			assert.equal(newResponse.status(), 200);
			assert.notEqual(current.payload.session_id, original.payload.session_id);
			assert.ok(
				afterWithdrawal.every(
					(event) => event.payload.query_id !== original.payload.query_id,
				),
			);
		} finally {
			await browser.close();
		}
	});
}

test("impression pressure reserves space for clicks and applies partial receipts", {
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
			const firstRequest = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const deliveries: string[][] = [];
			const dropped: string[] = [];
			const event = (action_name: string): Envelope => ({
				event_id: crypto.randomUUID(),
				profile_hash: "pressure-profile",
				kind: "event",
				payload: { action_name },
			});
			const click = event("click");
			const rejected = event("purchase");
			const clickRetried = Promise.withResolvers<void>();
			let clickAttempts = 0;

			const queue = createQueuedDelivery({
				profile: { tenant: "test", application: "pressure" },
				profileHash: click.profile_hash,
				async sendBatch(events) {
					deliveries.push(events.map(({ event_id }) => event_id));
					if (deliveries.length === 1) {
						firstRequest.resolve();
						await release.promise;
					}
					return events.map(({ event_id }) => {
						if (event_id === rejected.event_id)
							return { event_id, status: "rejected" };
						if (event_id === click.event_id) {
							if (++clickAttempts === 1) return { event_id, status: "retry" };
							clickRetried.resolve();
						}
						return { event_id, status: "accepted" };
					});
				},
				onDrop: (reason) => dropped.push(reason),
			});
			const signal = await queue.grant();
			const first = event("result_impression");
			await queue.enqueue(first, signal);
			await firstRequest.promise;
			for (let i = 1; i < 448; i++)
				await queue.enqueue(event("result_impression"), signal);
			try {
				await queue.enqueue(event("result_impression"), signal);
				throw new Error("impression exceeded its capacity");
			} catch (error) {
				if (!(error instanceof RangeError)) throw error;
			}
			await queue.enqueue(click, signal);
			await queue.enqueue(rejected, signal);
			release.resolve();
			await clickRetried.promise;
			await queue.close();

			return {
				deliveries,
				dropped,
				clickId: click.event_id,
				rejectedId: rejected.event_id,
				firstId: first.event_id,
			};
		});
		const { deliveries, dropped, clickId, rejectedId, firstId } = measured;
		assert.deepEqual(deliveries[0], [firstId]);
		assert.deepEqual(
			new Set(deliveries[1].slice(0, 2)),
			new Set([clickId, rejectedId]),
			"protected events bypass queued impressions",
		);
		assert.ok(deliveries.every((batch) => batch.length <= 32));
		assert.equal(deliveries.flat().filter((id) => id === clickId).length, 2);
		assert.equal(deliveries.flat().filter((id) => id === rejectedId).length, 1);
		assert.equal(deliveries.flat().filter((id) => id === firstId).length, 1);
		assert.deepEqual(dropped, ["capacity", "rejected"]);
	} finally {
		await browser.close();
	}
});

test("migrates v1 records and consent, honoring the UTF-8 batch byte limit", {
	timeout: 30_000,
}, async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.goto(origin);
		const measured = await page.evaluate(async () => {
			const scope = ["test", "migration"];
			const key = JSON.stringify(scope);
			const profileHash = "legacy-profile";
			const records: Envelope[] = Array.from({ length: 5 }, () => ({
				event_id: crypto.randomUUID(),
				profile_hash: profileHash,
				kind: "event",
				payload: {
					action_name: "result_impression",
					sample: "あ".repeat(10_000),
				},
			}));
			const click: Envelope = {
				...records[0],
				event_id: crypto.randomUUID(),
				payload: { action_name: "click" },
			};
			records.push(click);

			await new Promise<void>((resolve, reject) => {
				const open = indexedDB.open("liatris-delivery", 1);
				open.onupgradeneeded = () => {
					const db = open.result;
					db.createObjectStore("scopes");
					db.createObjectStore("outbox", {
						keyPath: ["scope", "record.event_id"],
					}).createIndex("scope", "scope");
				};
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const db = open.result;
					const tx = db.transaction(["scopes", "outbox"], "readwrite");
					tx.onabort = () => reject(tx.error);
					tx.oncomplete = () => {
						db.close();
						resolve();
					};
					tx.objectStore("scopes").put(
						{ generation: "v1", session: "saved" },
						key,
					);
					for (const record of records) {
						tx.objectStore("outbox").put({
							scope: key,
							record,
							expiresAt: Date.now() + 60_000,
							nextAttempt: Date.now(),
							attempts: 0,
						});
					}
				};
			});
			const { createQueuedDelivery } = (await import(
				"/assets/src/queued-delivery.js" as string
			)) as typeof import("../../src/queued-delivery.ts");
			const allSent = Promise.withResolvers<void>();
			const batches: Envelope[][] = [];
			const queue = createQueuedDelivery({
				profile: { tenant: scope[0], application: scope[1] },
				profileHash,
				async sendBatch(events) {
					batches.push([...events]);
					if (batches.flat().length === records.length) allSent.resolve();
					return events.map(({ event_id }) => ({
						event_id,
						status: "accepted",
					}));
				},
			});
			await queue.grant();
			const store = await queue.openSessionStore();
			let legacySession: unknown;
			await store.update(key, (session) => {
				legacySession = session;
				return null;
			});
			queue.resume();
			await allSent.promise;
			await queue.close();

			const encoder = new TextEncoder();
			return {
				migratedSession: legacySession,
				sizes: batches.map(
					(batch) => encoder.encode(JSON.stringify(batch)).length,
				),
				clickId: click.event_id,
				batches: batches.map((batch) => batch.map(({ event_id }) => event_id)),
				expected: records.map(({ event_id }) => event_id),
			};
		});
		assert.equal(measured.migratedSession, "saved");
		assert.equal(measured.batches[0][0], measured.clickId);
		assert.equal(measured.batches.length, 2);
		assert.ok(measured.sizes.every((size) => size <= 128 * 1024));
		assert.deepEqual(measured.batches.flat().sort(), measured.expected.sort());
	} finally {
		await browser.close();
	}
});

registerRecoveryTests(origin);
registerImpressionTests(origin);
