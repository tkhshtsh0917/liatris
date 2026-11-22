import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { createHttpReceiver } from "../server/http.ts";
import {
	batchMediaType,
	maxBatchEvents,
	readBatchReceipts,
} from "../src/batch.ts";
import { createHttpBatchDelivery } from "../src/http-delivery.ts";
import type { Envelope } from "../src/records.ts";
import { compileProfile } from "../tools/profile.ts";

const { profile, sha256 } = compileProfile(
	await readFile(new URL("../examples/shop.toml", import.meta.url), "utf8"),
	"toml",
);

function event(): Envelope {
	return {
		event_id: crypto.randomUUID(),
		kind: "event",
		profile_hash: sha256,
		payload: {
			application: profile.application,
			action_name: "add_cart",
			timestamp: new Date().toISOString(),
			session_id: crypto.randomUUID(),
		},
	};
}

test("rejects partial, duplicate, unknown, and malformed receipts", () => {
	const first = event();
	const second = event();
	const accepted = { event_id: first.event_id, status: "accepted" };
	const retry = { event_id: second.event_id, status: "retry" };
	assert.deepEqual(readBatchReceipts([retry, accepted], [first, second]), [
		retry,
		accepted,
	]);
	for (const receipts of [
		[accepted],
		[accepted, accepted],
		[accepted, { ...retry, event_id: event().event_id }],
		[accepted, { ...retry, status: "other" }],
	]) {
		assert.throws(
			() => readBatchReceipts(receipts, [first, second]),
			/batch receipt/,
		);
	}
});

test("the HTTP sender preserves the batch and requires a receipt for every event", async (t) => {
	const record = event();
	const response = [{ event_id: record.event_id, status: "accepted" }];
	const fetch = t.mock.method(
		globalThis,
		"fetch",
		async (_url: string, request: RequestInit) => {
			assert.equal(
				new Headers(request.headers).get("content-type"),
				batchMediaType,
			);
			assert.deepEqual(JSON.parse(String(request.body)), [record]);
			return Response.json(response);
		},
	);
	const send = createHttpBatchDelivery("https://collector.example/api");
	assert.deepEqual(
		await send([record], new AbortController().signal),
		response,
	);
	assert.equal(fetch.mock.callCount(), 1);
	response.length = 0;
	await assert.rejects(
		send([record], new AbortController().signal),
		/incomplete batch receipt/,
	);
});

test("reports acceptance, rejection and transient failure independently after the sink settles", async (t) => {
	const good = event();
	const invalid = { ...event(), profile_hash: "invalid" };
	const failed = event();
	const seen: string[] = [];
	const receiver = createServer();
	t.after(() => receiver.close());
	await new Promise<void>((resolve) =>
		receiver.listen(0, "127.0.0.1", resolve),
	);
	const address = receiver.address();
	assert.ok(address && typeof address === "object");
	const origin = `http://127.0.0.1:${address.port}`;
	receiver.on(
		"request",
		createHttpReceiver(
			profile,
			sha256,
			async (record) => {
				if (record.event_id === failed.event_id)
					throw new Error("store unavailable");
				seen.push(record.event_id);
			},
			{ loopbackOrigin: origin },
		),
	);
	const post = (records: unknown[]) =>
		fetch(origin, {
			method: "POST",
			headers: { "content-type": batchMediaType },
			body: JSON.stringify(records),
		});

	for (const entries of [
		[],
		[good, good],
		[good, {}],
		Array.from({ length: maxBatchEvents + 1 }, event),
	]) {
		assert.equal((await post(entries)).status, 400);
	}
	assert.deepEqual(seen, []);

	const response = await post([good, invalid, failed]);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), [
		{ event_id: good.event_id, status: "accepted" },
		{ event_id: invalid.event_id, status: "rejected" },
		{ event_id: failed.event_id, status: "retry" },
	]);
	assert.deepEqual(seen, [good.event_id]);
});
