import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compiled } from "../../../benchmarks/fixtures.ts";
import * as reference from "../../../src/records.ts";
import { nativeFactory } from "./native-adapter.ts";
import {
	createRecordReaders,
	encodeRequests,
	type Request,
} from "./projection.ts";
import { wasmFactory } from "./wasm-adapter.ts";

const code = await readFile(
	new URL(
		"../target/wasm32-unknown-unknown/release/liatris_event_core_experiment.wasm",
		import.meta.url,
	),
);
const module = await WebAssembly.compile(code);
const profile = structuredClone(compiled.profile);
profile.events.projection_test = {
	fields: {
		amount: { type: "number", minimum: 0.1 },
		count: { type: "integer", minimum: 0, required: true },
		label: { type: "string", maxLength: 4 },
		flag: { type: "boolean" },
	},
};

const event = (data: unknown, name = "projection_test"): Request => ({
	kind: "event",
	name,
	data,
});
const query = (data: unknown): Request => ({ kind: "query", data });
const queryId = "q";
const fields = {
	count: 7,
	amount: 0.10000000000000002,
	label: "日本😀",
	flag: true,
};
const attributes = {
	surface: "browse",
	position: { ordinal: 9 },
	object: { object_id: "品物", object_id_type: "product", is_sponsored: false },
};

const fixtures: Request[] = [
	event({ query_id: queryId, event_attributes: attributes, metadata: fields }),
	event({
		metadata: { count: Number.MAX_SAFE_INTEGER, amount: Number.MAX_VALUE },
	}),
	event({ metadata: { count: 0, label: "" } }),
	event({}, "add_cart"),
	event({ metadata: { count: Number.MAX_SAFE_INTEGER + 1 } }),
	event({ metadata: { count: 1.5 } }),
	event({ metadata: { count: 0, amount: 0.09999999999999999 } }),
	event({ metadata: { count: 0, label: "日本😀x" } }),
	event({ metadata: { count: 0, flag: 1 } }),
	event({ metadata: { count: 0, extra: true } }),
	event({ metadata: { count: 0 }, unexpected: true }),
	event({
		metadata: { count: 0 },
		event_attributes: { ...attributes, position: { ordinal: 0 } },
	}),
	event({
		metadata: { count: 0 },
		event_attributes: { object: attributes.object },
	}),
	event({ metadata: { count: 0 }, query_id: "" }),
	event({ metadata: { count: 0 }, event_attributes: null }),
	event({ metadata: {} }),
	event({}, "constructor"),
	query({
		query_id: queryId,
		user_query: "検索 😀",
		query_attributes: { experiment_id: "variant" },
	}),
	query({ query_id: queryId, user_query: "" }),
	query({ query_id: queryId, user_query: "😀".repeat(512) }),
	query({ query_id: queryId, user_query: "😀".repeat(513) }),
	query({
		query_id: queryId,
		user_query: "",
		query_attributes: { session_id: "private" },
	}),
	query({ query_id: queryId, user_query: "", query_attributes: null }),
];

function projectReference(request: Request) {
	try {
		return request.kind === "event"
			? reference.readEvent(profile, request.name, request.data)
			: reference.readQuery(profile, request.data);
	} catch {
		return null;
	}
}

for (const [name, factory] of [
	["native", nativeFactory],
	["wasm", wasmFactory(module)],
] as const) {
	test(`${name} matches the TypeScript projection for a mixed batch`, () => {
		const transport = factory(profile);
		const encoded = encodeRequests(fixtures);
		assert.ok(transport && encoded);
		const response = transport(encoded);
		assert.ok(response);
		assert.deepEqual(JSON.parse(response), fixtures.map(projectReference));
		assert.equal(transport("[]"), undefined);
		assert.equal(
			transport(JSON.stringify(Array(33).fill(fixtures[0]))),
			undefined,
		);
		assert.equal(transport(" ".repeat(128 * 1024 + 1)), undefined);

		const disabled = factory({ ...profile, allowQueryText: false });
		assert.equal(disabled?.(JSON.stringify([fixtures[17]])), "[null]");
	});

	test(`${name} preserves host-only values and never invokes getters`, () => {
		const readers = createRecordReaders(reference, factory);
		const data = { metadata: { count: -0 } };
		assert.ok(
			Object.is(
				readers.readEvent(profile, "projection_test", data).metadata.count,
				-0,
			),
		);
		assert.throws(
			() =>
				readers.readEvent(profile, "projection_test", {
					metadata: { count: 0, flag: undefined },
				}),
			/invalid custom field/,
		);
		assert.throws(
			() =>
				readers.readEvent(profile, "projection_test", {
					metadata: { count: 0, amount: Infinity },
				}),
			/invalid custom field/,
		);

		const loneSurrogate = String.fromCharCode(0xd800);
		const input = { query_id: queryId, user_query: loneSurrogate };
		assert.equal(factory(profile)?.(JSON.stringify([query(input)])), undefined);
		assert.equal(readers.readQuery(profile, input).user_query, loneSurrogate);
		assert.throws(
			() =>
				readers.readEvent(profile, "projection_test", {
					get metadata() {
						return assert.fail("getter was invoked");
					},
				}),
			/expected own data properties/,
		);
		assert.throws(
			() =>
				readers.readEvent(
					profile,
					"projection_test",
					new (class {
						metadata = { count: 0 };
					})(),
				),
			/expected a plain object/,
		);
	});
}
