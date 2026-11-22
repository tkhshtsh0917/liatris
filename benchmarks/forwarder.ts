import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openEventStore } from "../server/event-store.ts";
import { compiled, impression } from "./fixtures.ts";

export async function benchmarkForwarder() {
	const directory = await mkdtemp(join(tmpdir(), "liatris-forward-perf-"));
	const dbPath = join(directory, "intake.sqlite");
	const { profile } = compiled;
	const store = openEventStore(dbPath, profile);
	const delayMs = 40;
	let firstPublishAt = 0;
	let batches = 0;
	let count = 0;
	const destination = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk);
		const names = JSON.parse(Buffer.concat(chunks).toString()) as {
			Records: unknown[];
			StreamName: string;
		};
		assert.equal(names.StreamName, "benchmark");
		if (!firstPublishAt) firstPublishAt = performance.now();
		count += names.Records.length;
		batches++;
		await sleep(delayMs);
		response.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
		response.end(
			JSON.stringify({
				FailedRecordCount: 0,
				Records: names.Records.map(() => ({
					ShardId: "local-shard",
					SequenceNumber: "1",
				})),
			}),
		);
	});
	await new Promise<void>((resolve) =>
		destination.listen(0, "127.0.0.1", resolve),
	);
	const address = destination.address();
	assert.ok(address && typeof address === "object");
	const worker = spawn(process.execPath, ["tools/forward-kinesis.ts"], {
		env: {
			...process.env,
			LIATRIS_DB: dbPath,
			LIATRIS_KINESIS_STREAM: "benchmark",
			AWS_ENDPOINT_URL_KINESIS: `http://127.0.0.1:${address.port}`,
			AWS_REGION: "us-east-1",
			AWS_ACCESS_KEY_ID: "benchmark",
			AWS_SECRET_ACCESS_KEY: "benchmark",
			AWS_EC2_METADATA_DISABLED: "true",
		},
		stdio: ["ignore", "inherit", "inherit"],
	});
	async function waitForDelivery() {
		const deadline = performance.now() + 20_000;
		while (store.pending(1).length) {
			assert.ok(
				worker.exitCode === null && performance.now() < deadline,
				"worker did not finish",
			);
			await sleep(5);
		}
	}

	try {
		await store.accept(impression());
		await waitForDelivery();
		const idleLatencies: number[] = [];
		for (let i = 0; i < 5; i++) {
			await sleep(200);
			const started = performance.now();
			await store.accept(impression());
			await waitForDelivery();
			idleLatencies.push(performance.now() - started);
		}
		console.log(
			JSON.stringify({ stage: "idle-forwarder", delayMs, idleLatencies }),
		);

		const target = 2000;
		firstPublishAt = 0;
		batches = 0;
		count = 0;
		for (let i = 0; i < target; i++) await store.accept(impression());
		await waitForDelivery();
		assert.equal(count, target);
		const elapsed = performance.now() - firstPublishAt;
		console.log(
			JSON.stringify({
				stage: "busy-forwarder",
				delayMs,
				count,
				batches,
				elapsed,
				eventsPerSecond: (count * 1000) / elapsed,
			}),
		);
	} finally {
		if (worker.exitCode === null && worker.signalCode === null) {
			const stopped = once(worker, "exit");
			worker.kill();
			await stopped;
		}
		destination.close();
		store.close();
		await rm(directory, { recursive: true });
	}
}
