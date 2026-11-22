import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openEventStore } from "../server/event-store.ts";
import { createHttpReceiver } from "../server/http.ts";
import type { Envelope } from "../src/records.ts";
import { compileProfile } from "../tools/profile.ts";

const { profile, sha256 } = compileProfile(
	await readFile(new URL("../examples/shop.toml", import.meta.url), "utf8"),
	"toml",
);

function record(): Envelope {
	return {
		event_id: crypto.randomUUID(),
		profile_hash: sha256,
		kind: "event",
		payload: {
			application: profile.application,
			action_name: "add_cart",
			timestamp: new Date().toISOString(),
			session_id: crypto.randomUUID(),
		},
	};
}

test("keeps acknowledgements idempotent across restarts and isolates tenants", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "liatris-events-"));
	t.after(() => rm(directory, { recursive: true }));

	const path = join(directory, "intake.sqlite");
	const first = record();
	const original = openEventStore(path, profile);
	try {
		assert.equal(await original.accept(first), undefined);
	} finally {
		original.close();
	}

	const reopened = openEventStore(path, profile);
	const other = openEventStore(path, { ...profile, tenant: "other" });
	try {
		const reversed = Object.fromEntries(
			Object.entries(first).reverse(),
		) as Envelope;
		assert.equal(await reopened.accept(reversed), undefined);
		await assert.rejects(
			reopened.accept({ ...first, metadata: { different: true } }),
			/different payload/,
		);
		assert.deepEqual(reopened.pending(5), [first]);
		assert.deepEqual(other.pending(5), []);
		assert.equal(await other.accept(first), undefined);

		reopened.markForwarded([first.event_id]);
		assert.deepEqual(reopened.pending(5), []);
		assert.deepEqual(other.pending(5), [first]);
		assert.equal(await reopened.accept(first), undefined);
		assert.deepEqual(reopened.pending(5), []);
	} finally {
		other.close();
		reopened.close();
	}
});

test("returns 204 after storing duplicates and 409 for conflicting data", async (t) => {
	const store = openEventStore(":memory:", profile);
	const server = createServer();
	t.after(() => {
		server.close();
		store.close();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const origin = `http://127.0.0.1:${address.port}`;
	server.on(
		"request",
		createHttpReceiver(profile, sha256, store.accept, {
			loopbackOrigin: origin,
		}),
	);

	const event = record();
	const post = (body: Envelope) =>
		fetch(origin, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	assert.equal((await post(event)).status, 204);
	assert.equal((await post(event)).status, 204);
	assert.equal(
		(
			await post({
				...event,
				payload: { ...event.payload, session_id: crypto.randomUUID() },
			})
		).status,
		409,
	);
	assert.deepEqual(store.pending(5), [event]);
});
