import assert from "node:assert/strict";
import test from "node:test";
import { openEventStore } from "../server/event-store.ts";
import { forwardToKinesis } from "../server/kinesis.ts";
import type { Envelope } from "../src/records.ts";

test("marks accepted Kinesis records and retries just the failed records with their original IDs", async (t) => {
	const store = openEventStore(":memory:", {
		tenant: "test",
		application: "search",
	});
	t.after(() => store.close());
	const first: Envelope = {
		event_id: crypto.randomUUID(),
		profile_hash: "test",
		kind: "event",
		payload: { session_id: "session" },
	};
	const second: Envelope = { ...first, event_id: crypto.randomUUID() };
	await store.accept(first);
	await store.accept(second);

	await assert.rejects(
		forwardToKinesis(store, "ubi", async () => {
			throw new Error("batch unreachable");
		}),
		/unreachable/,
	);
	const partial = await forwardToKinesis(store, "ubi", async (input) => {
		assert.deepEqual(
			input.Records?.map((record) =>
				JSON.parse(Buffer.from(record.Data ?? []).toString()),
			),
			[first, second],
		);
		assert.deepEqual(
			input.Records?.map((record) => record.PartitionKey),
			["session", "session"],
		);
		return {
			$metadata: {},
			FailedRecordCount: 1,
			Records: [
				{ ShardId: "shard", SequenceNumber: "1" },
				{ ErrorCode: "ProvisionedThroughputExceededException" },
			],
		};
	});
	assert.deepEqual(partial, { sent: 1, failed: 1 });
	assert.deepEqual(store.pending(5), [second]);

	const retried = await forwardToKinesis(store, "ubi", async (input) => {
		assert.deepEqual(
			input.Records?.map((record) =>
				JSON.parse(Buffer.from(record.Data ?? []).toString()),
			),
			[second],
		);
		return {
			$metadata: {},
			FailedRecordCount: 0,
			Records: [{ ShardId: "shard", SequenceNumber: "2" }],
		};
	});
	assert.deepEqual(retried, { sent: 1, failed: 0 });
	assert.deepEqual(store.pending(5), []);
});
