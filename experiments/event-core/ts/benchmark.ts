import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { compiled, percentile } from "../../../benchmarks/fixtures.ts";
import { readEvent, readQuery } from "../../../src/records.ts";
import { nativeFactory } from "./native-adapter.ts";
import { encodeRequests, type Request } from "./projection.ts";
import { wasmFactory } from "./wasm-adapter.ts";

function workloads() {
	const exposure: Request = {
		kind: "event",
		name: "result_impression",
		data: {
			query_id: "query",
			event_attributes: {
				position: { ordinal: 3 },
				object: { object_id: "sample-item", object_id_type: "product" },
			},
			metadata: { result_set: "visible-set" },
		},
	};
	const profile = structuredClone(compiled.profile);
	const customFields = Array.from({ length: 20 }, (_, i) => `field${i}`);
	profile.events.rich_input = {
		fields: Object.fromEntries(
			customFields.map((field) => [
				field,
				{ type: "string", maxLength: 240, required: true },
			]),
		),
	};
	const rich: Request = {
		kind: "event",
		name: "rich_input",
		data: {
			query_id: "query",
			metadata: Object.fromEntries(
				customFields.map((field) => [field, `日本語${field}`.repeat(6)]),
			),
		},
	};
	return { profile, exposure, rich };
}

export async function benchmarkProjection() {
	const bytes = await readFile(
		new URL(
			"../target/wasm32-unknown-unknown/release/liatris_event_core_experiment.wasm",
			import.meta.url,
		),
	);
	const { profile, exposure, rich } = workloads();
	const native = nativeFactory(profile);
	const wasm = wasmFactory(await WebAssembly.compile(bytes))(profile);
	assert.ok(native && wasm);
	console.log(
		JSON.stringify({
			stage: "projection-assets",
			wasmBytes: bytes.length,
			wasmGzipBytes: gzipSync(bytes).length,
		}),
	);

	const reference = (requests: readonly Request[]) =>
		JSON.stringify(
			requests.map((request) =>
				request.kind === "event"
					? readEvent(profile, request.name, request.data)
					: readQuery(profile, request.data),
			),
		);
	const run = (
		project: (encoded: string) => string | undefined,
		requests: readonly Request[],
	) => {
		const encoded = encodeRequests(requests);
		if (encoded === undefined) throw new Error("fixture could not be encoded");
		const result = project(encoded);
		if (result === undefined)
			throw new Error("candidate could not project fixture");
		return result;
	};
	const variants = [
		{ backend: "typescript", run: reference },
		{
			backend: "native",
			run: (requests: readonly Request[]) => run(native, requests),
		},
		{
			backend: "wasm",
			run: (requests: readonly Request[]) => run(wasm, requests),
		},
	];

	for (const [workload, request] of [
		["impression", exposure],
		["rich-metadata", rich],
	] as const) {
		for (const count of [1, 32]) {
			const requests = Array.from({ length: count }, () => request);
			const expected = JSON.parse(reference(requests));
			const rounds = Math.ceil(
				(workload === "impression" ? 30_000 : 10_000) / count,
			);
			const results = variants.map(({ backend }) => ({
				backend,
				times: [] as number[],
			}));
			for (const variant of variants) {
				assert.deepEqual(JSON.parse(variant.run(requests)), expected);
				for (let i = 0; i < 250; i++) variant.run(requests);
			}

			for (let trial = 0; trial < 3; trial++) {
				for (let i = 0; i < variants.length; i++) {
					const index = (trial + i) % variants.length;
					const variant = variants[index];
					let output = 0;
					const started = performance.now();
					for (let repeat = 0; repeat < rounds; repeat++)
						output += variant.run(requests).length;
					assert.ok(output > 0);
					results[index].times.push(
						((performance.now() - started) * 1000) / (rounds * count),
					);
				}
			}

			for (const { backend, times } of results)
				console.log(
					JSON.stringify({
						stage: "projection",
						workload,
						count,
						backend,
						inputBytes: Buffer.byteLength(JSON.stringify(requests)),
						usPerEvent: percentile(times, 0.5),
						trials: times,
					}),
				);
		}
	}
}
