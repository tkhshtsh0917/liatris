import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventStore } from "../server/event-store.ts";
import { createHttpReceiver } from "../server/http.ts";
import { compiled, impression, percentile } from "./fixtures.ts";

export async function benchmarkReceiver() {
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
					const records = Array.from({ length: count }, () =>
						JSON.stringify(impression()),
					);
					const latencies: number[] = [];
					let next = 0;
					const started = performance.now();
					await Promise.all(
						Array.from({ length: concurrency }, async () => {
							for (;;) {
								const body = records[next++];
								if (body === undefined) return;
								const sentAt = performance.now();
								const response = await fetch(url, {
									method: "POST",
									headers: {
										"content-type": "application/json",
										authorization: `Bearer ${token}`,
									},
									body,
									signal: AbortSignal.timeout(15_000),
								});
								assert.equal(response.status, 204);
								latencies.push(performance.now() - sentAt);
							}
						}),
					);
					const elapsed = performance.now() - started;
					return {
						count,
						bytes: Buffer.byteLength(records[0]),
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
