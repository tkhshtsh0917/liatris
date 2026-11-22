import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventStore } from "../server/event-store.ts";
import { createHttpReceiver } from "../server/http.ts";
import {
	batchMediaType,
	maxBatchEvents,
	readBatchReceipts,
} from "../src/batch.ts";
import { compiled, impression, percentile } from "./fixtures.ts";

export async function benchmarkReceiver(batched: boolean) {
	const batchSize = batched ? maxBatchEvents : 1;
	const directory = await mkdtemp(join(tmpdir(), "liatris-intake-perf-"));
	const { profile, sha256 } = compiled;
	const token = crypto.randomUUID();
	try {
		for (const concurrency of [1, 8, 32, 64]) {
			const store = openEventStore(
				join(directory, `intake-${concurrency}.sqlite`),
				profile,
			);
			const instance = createServer(
				createHttpReceiver(profile, sha256, store.accept, {
					audience: "benchmark",
					async verifyBearer(credential) {
						if (credential === token)
							return {
								tenant: profile.tenant,
								application: profile.application,
								audience: "benchmark",
								permission: "liatris:write",
								expiresAtMs: Date.now() + 60_000,
							};
					},
				}),
			);
			try {
				await new Promise<void>((resolve) =>
					instance.listen(0, "127.0.0.1", resolve),
				);
				const address = instance.address();
				assert.ok(address && typeof address === "object");
				const url = `http://127.0.0.1:${address.port}/api/ubi`;

				async function run(count: number) {
					const records = Array.from({ length: count }, () => impression());
					const requests = Array.from(
						{ length: Math.ceil(count / batchSize) },
						(_, index) => {
							const batch = records.slice(
								index * batchSize,
								(index + 1) * batchSize,
							);
							return {
								batch,
								body: JSON.stringify(batched ? batch : batch[0]),
							};
						},
					);
					const latencies: number[] = [];
					let next = 0;
					const started = performance.now();
					await Promise.all(
						Array.from({ length: concurrency }, async () => {
							for (;;) {
								const request = requests[next++];
								if (request === undefined) return;
								const sentAt = performance.now();
								const response = await fetch(url, {
									method: "POST",
									headers: {
										"content-type": batched
											? batchMediaType
											: "application/json",
										authorization: `Bearer ${token}`,
									},
									body: request.body,
									signal: AbortSignal.timeout(15_000),
								});
								assert.equal(response.status, batched ? 200 : 204);
								if (batched) {
									const receipts = readBatchReceipts(
										await response.json(),
										request.batch,
									);
									assert.ok(
										receipts.every(({ status }) => status === "accepted"),
									);
								}
								latencies.push(performance.now() - sentAt);
							}
						}),
					);
					const elapsed = performance.now() - started;
					return {
						count,
						bytes: Buffer.byteLength(JSON.stringify(records[0])),
						posts: requests.length,
						elapsed,
						eventsPerSecond: (count * 1000) / elapsed,
						p50: percentile(latencies, 0.5),
						p95: percentile(latencies, 0.95),
						p99: percentile(latencies, 0.99),
					};
				}

				await run(250);
				for (let trial = 1; trial <= 3; trial++) {
					console.log(
						JSON.stringify({
							stage: "receiver",
							batchSize,
							concurrency,
							trial,
							...(await run(2000)),
						}),
					);
				}
			} finally {
				await new Promise<void>((resolve, reject) =>
					instance.close((error) => (error ? reject(error) : resolve())),
				);
				store.close();
			}
		}
	} finally {
		await rm(directory, { recursive: true });
	}
}
