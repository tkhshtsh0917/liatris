import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { createHttpReceiver } from "../server/http.ts";
import {
	createCollector,
	createHttpDelivery,
	type Delivery,
} from "../src/collector.ts";
import type { Envelope } from "../src/records.ts";
import { memorySessionStore } from "../src/session-store.ts";
import { compileProfile } from "../tools/profile.ts";

const wasm = await readFile(
	new URL(
		"../target/wasm32-unknown-unknown/release/liatris_session.wasm",
		import.meta.url,
	),
);
const { profile, sha256 } = compileProfile(
	await readFile(new URL("../examples/shop.toml", import.meta.url), "utf8"),
	"toml",
);
const query = { query_id: "demo-query", user_query: "garden tools" };
const click = {
	query_id: query.query_id,
	event_attributes: {
		position: { ordinal: 2 },
		object: { object_id: "spade", object_id_type: "product" },
	},
	metadata: { result_set: "display-1" },
};

function fixture(deliver: Delivery, config = profile) {
	let opened = 0;
	const store = memorySessionStore();
	const collector = createCollector({
		profile: config,
		profileHash: sha256,
		async openStore() {
			opened++;
			return store;
		},
		async loadWasm() {
			return wasm;
		},
		deliver,
	});
	return { collector, opened: () => opened };
}

test("sends query and click through the HTTP receiver with the same session and actual rank", async (t) => {
	const records: Envelope[] = [];
	const server = createServer(
		createHttpReceiver(profile, sha256, async (record) => {
			records.push(record);
		}),
	);
	t.after(() => {
		server.close();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const { collector } = fixture(
		createHttpDelivery(`http://127.0.0.1:${address.port}/api/ubi`),
	);

	await collector.setConsent(true);
	assert.equal(await collector.trackQuery(query), "sent");
	assert.equal(await collector.trackEvent("click", click), "sent");
	assert.equal(await collector.trackEvent("add_cart"), "sent");

	assert.deepEqual(
		records.map((record) => record.payload.query_id),
		[query.query_id, query.query_id, undefined],
	);
	assert.deepEqual(records[1].payload.event_attributes, click.event_attributes);
	assert.deepEqual(records[1].metadata, click.metadata);
	assert.equal(records[2].payload.event_attributes, undefined);
	const { session_id } = records[0].payload.query_attributes as {
		session_id: string;
	};
	assert.equal(records[1].payload.session_id, session_id);
	assert.equal(records[2].payload.session_id, session_id);
});

test("rejects disabled text, undeclared events, bad rank and missing required metadata before opening state", async () => {
	const shouldNotSend = () => assert.fail("unexpected delivery");
	const disabled = fixture(shouldNotSend, {
		...profile,
		allowQueryText: false,
	});
	await disabled.collector.setConsent(true);
	assert.equal(
		await disabled.collector.trackQuery(query),
		"query-text-disabled",
	);
	assert.equal(disabled.opened(), 0);

	const { collector, opened } = fixture(shouldNotSend);
	assert.equal(await collector.trackQuery(query), "no-consent");
	await collector.setConsent(true);
	await assert.rejects(collector.trackEvent("constructor"), /undeclared event/);
	await assert.rejects(
		collector.trackEvent("click", { ...click, metadata: {} }),
		/required/,
	);
	await assert.rejects(
		collector.trackEvent("click", {
			...click,
			event_attributes: { position: { ordinal: 0 } },
		}),
		/displayed rank/,
	);
	assert.equal(opened(), 0);
});

test("aborts in-flight delivery on revocation and starts a new session after consent", async () => {
	const { promise: started, resolve } = Promise.withResolvers<void>();
	const sessionIds: unknown[] = [];
	const { collector } = fixture(async (record, signal) => {
		sessionIds.push(record.payload.session_id);
		if (sessionIds.length > 1) return;

		resolve();
		await new Promise<void>((_, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
		});
	});

	await collector.setConsent(true);
	const pending = collector.trackEvent("click", click);
	await started;
	await collector.setConsent(false);
	assert.equal(await pending, "no-consent");
	assert.equal(await collector.trackEvent("click", click), "no-consent");
	await collector.setConsent(true);
	assert.equal(await collector.trackEvent("click", click), "sent");
	assert.notEqual(sessionIds[0], sessionIds[1]);
});

test("a fresh collector can revoke a previously persisted session without loading WASM", async () => {
	const store = memorySessionStore();
	const sessionIds: unknown[] = [];
	const options = {
		profile,
		profileHash: sha256,
		async openStore() {
			return store;
		},
		async loadWasm() {
			return wasm;
		},
		async deliver(record: Envelope) {
			sessionIds.push(record.payload.session_id);
		},
	};
	const original = createCollector(options);
	await original.setConsent(true);
	await original.trackEvent("click", click);

	const reopened = createCollector({
		...options,
		async loadWasm() {
			assert.fail("cleanup loaded WASM");
		},
	});
	await reopened.setConsent(false);

	await original.trackEvent("click", click);
	assert.notEqual(sessionIds[0], sessionIds[1]);
});

test("failed revocation keeps collection disabled until cleanup can be retried", async () => {
	const store = memorySessionStore();
	let shouldFail = false;
	const collector = createCollector({
		profile,
		profileHash: sha256,
		async openStore() {
			return {
				async update(key, next) {
					if (shouldFail) throw new Error("storage unavailable");
					return store.update(key, next);
				},
			};
		},
		async loadWasm() {
			return wasm;
		},
		async deliver() {},
	});

	await collector.setConsent(true);
	await collector.trackEvent("click", click);
	shouldFail = true;
	await assert.rejects(collector.setConsent(false), /storage unavailable/);
	await assert.rejects(collector.setConsent(true), /session cleanup/);
	assert.equal(await collector.trackEvent("click", click), "no-consent");

	shouldFail = false;
	await collector.setConsent(false);
	await collector.setConsent(true);
	assert.equal(await collector.trackEvent("click", click), "sent");
});
