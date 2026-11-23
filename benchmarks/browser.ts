import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, firefox, webkit } from "playwright";
import type { Envelope } from "../src/records.ts";
import { compiled, percentile } from "./fixtures.ts";

export async function benchmarkBrowser(useRust = false) {
	const origin = "https://liatris-benchmark.test";
	const { profile, sha256 } = compiled;
	const wasm = await readFile(
		new URL(
			"../target/wasm32-unknown-unknown/release/liatris_session.wasm",
			import.meta.url,
		),
	);
	const root = new URL("../dist/demo/src/", import.meta.url);
	const experiment = useRust
		? {
				module: await readFile(
					new URL(
						"../experiments/event-core/target/wasm32-unknown-unknown/release/liatris_event_core_experiment.wasm",
						import.meta.url,
					),
				),
				shim: await readFile(
					new URL(
						"../experiments/event-core/ts/browser-records.js",
						import.meta.url,
					),
				),
				files: new URL(
					"../dist/event-core/experiments/event-core/ts/",
					import.meta.url,
				),
			}
		: undefined;
	const scenarios = [
		{ cards: 40, delayMs: 0 },
		{ cards: 40, delayMs: 40 },
		{ cards: 100, delayMs: 0 },
		{ cards: 100, delayMs: 40 },
		{ cards: 100, delayMs: 150 },
		{ cards: 250, delayMs: 40 },
	];
	for (const engine of [chromium, firefox, webkit]) {
		const browser = await engine.launch();
		try {
			for (const scenario of scenarios) {
				const page = await browser.newPage({
					viewport: { width: 1280, height: 720 },
				});
				try {
					let posts = 0;
					let maxBatch = 0;
					await page.route(`${origin}/**`, async (route) => {
						const path = new URL(route.request().url()).pathname;
						if (path === "/")
							return route.fulfill({
								contentType: "text/html",
								body: "<main></main>",
							});
						if (path === "/session.wasm")
							return route.fulfill({
								contentType: "application/wasm",
								body: wasm,
							});
						if (path === "/api/ubi") {
							const records = route.request().postDataJSON() as Envelope[];
							posts++;
							maxBatch = Math.max(maxBatch, records.length);
							if (scenario.delayMs) await sleep(scenario.delayMs);
							return route.fulfill({
								status: 200,
								json: records.map(({ event_id }) => ({
									event_id,
									status: "accepted",
								})),
							});
						}
						if (experiment) {
							if (path === "/event-core.wasm")
								return route.fulfill({
									contentType: "application/wasm",
									body: experiment.module,
								});
							if (path === "/records.js")
								return route.fulfill({
									contentType: "text/javascript",
									body: experiment.shim,
								});
							if (path === "/records-reference.js")
								return route.fulfill({
									contentType: "text/javascript",
									body: await readFile(new URL("records.js", root)),
								});
							if (path === "/src/fields.js")
								return route.fulfill({
									contentType: "text/javascript",
									body: await readFile(new URL("fields.js", root)),
								});
							if (
								path === "/experiment/projection.js" ||
								path === "/experiment/wasm-adapter.js"
							)
								return route.fulfill({
									contentType: "text/javascript",
									body: await readFile(
										new URL(path.slice(12), experiment.files),
									),
								});
						}
						if (/^\/[a-z-]+\.js$/.test(path)) {
							return route.fulfill({
								contentType: "text/javascript",
								body: await readFile(new URL(path.slice(1), root)),
							});
						}
						await route.abort();
					});
					await page.goto(origin);
					const measurement = await page.evaluate(
						async ({ profile, sha256, cards }) => {
							const loading = performance.now();
							const [collectorModule, queueModule, exposureModule] =
								await Promise.all([
									import("/collector.js" as string) as Promise<
										typeof import("../src/collector.ts")
									>,
									import("/queued-delivery.js" as string) as Promise<
										typeof import("../src/queued-delivery.ts")
									>,
									import("/impressions.js" as string) as Promise<
										typeof import("../src/impressions.ts")
									>,
								]);
							const moduleLoadMs = performance.now() - loading;
							const http = collectorModule.createHttpBatchDelivery(
								profile.endpoint,
							);
							const receipts: { time: number; click: boolean }[] = [];
							const starting = performance.now();
							const queue = queueModule.createQueuedDelivery({
								profile,
								profileHash: sha256,
								parallelBatches: 2,
								async sendBatch(events, signal) {
									const result = await http(events, signal);
									const accepted = new Set(
										result
											.filter(({ status }) => status === "accepted")
											.map(({ event_id }) => event_id),
									);
									const time = performance.now() - starting;
									for (const event of events) {
										if (accepted.has(event.event_id))
											receipts.push({
												time,
												click: event.payload.action_name === "click",
											});
									}
									return result;
								},
							});
							const collector = collectorModule.createCollector({
								profile,
								profileHash: sha256,
								queue,
								async loadWasm() {
									const response = await fetch("/session.wasm");
									return response.arrayBuffer();
								},
							});
							await collector.setConsent(true);
							const burstAt = performance.now();
							const latencies: number[] = [];
							const tasks: Promise<unknown>[] = [];
							const observed = Promise.withResolvers<void>();
							let dropped = 0;
							const main = document.querySelector("main");
							if (!main) throw new Error("benchmark surface is missing");
							main.style.display = "grid";
							main.style.gridTemplateColumns = "repeat(25, 30px)";
							const queryId = crypto.randomUUID();
							const resultSet = crypto.randomUUID();
							const observer = exposureModule.observeResultImpressions(
								{},
								(rank) => {
									const began = performance.now();
									tasks.push(
										collector
											.trackEvent("result_impression", {
												query_id: queryId,
												event_attributes: {
													position: { ordinal: rank },
													object: { object_id: `item-${rank}` },
												},
												metadata: { result_set: resultSet },
											})
											.then((status) => {
												if (status !== "queued") throw new Error(status);
												latencies.push(performance.now() - began);
											})
											.catch((error) => {
												if (
													!(error instanceof RangeError) ||
													error.message !== "collection queue is full"
												)
													throw error;
												dropped++;
											}),
									);
									if (tasks.length === cards) observed.resolve();
								},
							);
							for (let rank = 1; rank <= cards; rank++) {
								const card = document.createElement("div");
								card.style.height = "20px";
								main.append(card);
								observer.observe(card, rank);
							}
							const checks = await Promise.race([
								observed.promise.then(() => Promise.all(tasks)),
								new Promise((_, reject) =>
									setTimeout(
										() => reject(new Error("impression burst timed out")),
										10_000,
									),
								),
							]);
							if (!checks)
								throw new Error("impression benchmark did not finish");
							observer.close();

							const clickAt = performance.now() - starting;
							let clickQueued = true;
							try {
								await collector.trackEvent("click", {
									query_id: queryId,
									event_attributes: {
										position: { ordinal: 2 },
										object: { object_id: "item-2" },
									},
									metadata: { result_set: resultSet },
								});
							} catch (error) {
								if (
									!(error instanceof RangeError) ||
									error.message !== "collection queue is full"
								)
									throw error;
								clickQueued = false;
							}
							const deadline = performance.now() + 25_000;
							const total = latencies.length + Number(clickQueued);
							while (receipts.length < total && performance.now() < deadline) {
								await new Promise((resolve) => setTimeout(resolve, 20));
							}
							if (receipts.length !== total)
								throw new Error("queue did not finish draining");
							await queue.close();
							const click = receipts.find((receipt) => receipt.click);
							return {
								moduleLoadMs,
								clickAckMs: click ? click.time - clickAt : null,
								accepted: latencies.length,
								dropped,
								clickQueued,
								latencies,
								receipts: receipts
									.filter(({ click }) => !click)
									.map(({ time }) => time - (burstAt - starting)),
							};
						},
						{ ...scenario, profile, sha256 },
					);
					const {
						moduleLoadMs,
						accepted,
						dropped,
						clickQueued,
						clickAckMs,
						latencies,
						receipts,
					} = measurement;
					console.log(
						JSON.stringify({
							stage: "browser",
							backend: useRust ? "rust-wasm" : "typescript",
							moduleLoadMs,
							engine: engine.name(),
							version: browser.version(),
							...scenario,
							accepted,
							dropped,
							clickQueued,
							clickAckMs,
							posts,
							maxBatch,
							enqueueP50: percentile(latencies, 0.5),
							enqueueP95: percentile(latencies, 0.95),
							ackP95: percentile(receipts, 0.95),
							lastAck: Math.max(...receipts),
						}),
					);
				} finally {
					await page.close();
				}
			}
		} finally {
			await browser.close();
		}
	}
}
