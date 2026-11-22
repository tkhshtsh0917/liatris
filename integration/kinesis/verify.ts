import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import {
	CreateStreamCommand,
	GetRecordsCommand,
	GetShardIteratorCommand,
	KinesisClient,
	ListShardsCommand,
	ListStreamsCommand,
	PutRecordsCommand,
} from "@aws-sdk/client-kinesis";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { openEventStore } from "../../server/event-store.ts";
import { createHttpReceiver } from "../../server/http.ts";
import { forwardToKinesis } from "../../server/kinesis.ts";
import { compileProfile } from "../../tools/profile.ts";

if (process.env.AWS_ENDPOINT_URL_KINESIS !== "http://moto:5000") {
	throw new Error("the verification requires the Compose Moto endpoint");
}
const client = new KinesisClient({
	maxAttempts: 1,
	requestHandler: new NodeHttpHandler(),
});
const { profile, sha256 } = compileProfile(
	await readFile(new URL("../../examples/shop.toml", import.meta.url), "utf8"),
	"toml",
);
const store = openEventStore("/tmp/intake.sqlite", profile);
const token = crypto.randomUUID();
const receiver = createHttpReceiver(profile, sha256, store.accept, {
	audience: "integration",
	async verifyBearer(credential) {
		if (credential === token)
			return {
				tenant: profile.tenant,
				application: profile.application,
				audience: "integration",
				permission: "liatris:write",
				expiresAtMs: Date.now() + 60_000,
			};
	},
});
const server = createServer(receiver);
try {
	for (let attempt = 0; ; attempt++) {
		try {
			await client.send(new ListStreamsCommand({}), {
				abortSignal: AbortSignal.timeout(1_000),
			});
			break;
		} catch (error) {
			if (attempt === 29) throw error;
			await sleep(500);
		}
	}
	const stream = `liatris-${crypto.randomUUID()}`;
	await client.send(
		new CreateStreamCommand({ StreamName: stream, ShardCount: 1 }),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const post = (record: object) =>
		fetch(`http://127.0.0.1:${address.port}/api/ubi`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(record),
		});
	const record = {
		event_id: crypto.randomUUID(),
		kind: "event",
		profile_hash: sha256,
		payload: {
			action_name: "add_cart",
			application: profile.application,
			timestamp: new Date().toISOString(),
			session_id: crypto.randomUUID(),
		},
	};
	assert.equal((await post(record)).status, 204);
	assert.equal((await post(record)).status, 204);
	const result = await forwardToKinesis(store, stream, (input) =>
		client.send(new PutRecordsCommand(input)),
	);
	assert.deepEqual(result, { sent: 1, failed: 0 });
	assert.deepEqual(store.pending(1), []);

	const { Shards } = await client.send(
		new ListShardsCommand({ StreamName: stream }),
	);
	assert.ok(Shards?.[0]?.ShardId);
	const { ShardIterator } = await client.send(
		new GetShardIteratorCommand({
			StreamName: stream,
			ShardId: Shards[0].ShardId,
			ShardIteratorType: "TRIM_HORIZON",
		}),
	);
	assert.ok(ShardIterator);
	const { Records } = await client.send(
		new GetRecordsCommand({ ShardIterator }),
	);
	assert.deepEqual(
		Records?.map(({ Data }) => JSON.parse(Buffer.from(Data ?? []).toString())),
		[record],
	);
	console.log("Kinesis round trip passed");
} finally {
	server.close();
	client.destroy();
	store.close();
}
