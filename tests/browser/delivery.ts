import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { after, before } from "node:test";
import { chromium, firefox, type Page, webkit } from "playwright";
import { openEventStore } from "../../server/event-store.ts";
import type { Envelope } from "../../src/records.ts";

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
				const record = route.request().postDataJSON() as Envelope;
				if (!loseAcknowledgement) return route.continue();
				if (isSubmission(record)) {
					const response = await route.fetch();
					assert.equal(response.status(), 204);
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
					(response.request().postDataJSON() as Envelope).event_id ===
						original.event_id,
			);
			await grant(page);
			const receipt = await retried;
			assert.equal(receipt.status(), 204);
			assert.deepEqual(receipt.request().postDataJSON(), original);

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
				const record = route.request().postDataJSON() as Envelope;
				if (offline) {
					await route.fulfill({
						status: 503,
						headers: { "retry-after": "60" },
					});
					if (isSubmission(record)) delayed.resolve(record);
				} else {
					afterWithdrawal.push(record);
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
					isSubmission(response.request().postDataJSON() as Envelope),
			);
			await search(peer);
			const newResponse = await posted;
			const current = newResponse.request().postDataJSON() as Envelope;
			assert.equal(newResponse.status(), 204);
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
