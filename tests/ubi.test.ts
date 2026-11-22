import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { acceptsUbi } from "../server/ubi.ts";
import { validateRecord } from "../server/validate.ts";
import { compileProfile } from "../tools/profile.ts";

const files = {
	"event.schema.json":
		"047322dea1dad6a24702587476046e1441037f43b4bb64d2bf64e6147496dd21",
	"query.request.schema.json":
		"788725ddf1803df12c238e28e4734599e1b2d24e54f2404c1a90bd4afbd85cf7",
	"query.response.schema.json":
		"1ced24082254d06bc32aea538a91e3200793f2ff343abc9b2b7899025338c7d8",
};

test("vendored UBI schemas preserve the bytes of the pinned upstream commit", async () => {
	for (const [file, expected] of Object.entries(files)) {
		const bytes = await readFile(
			new URL(`../schema/upstream/ubi-1.3.0/${file}`, import.meta.url),
		);
		assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
	}
});

test("compat mode accepts the two overlapping values and still requires one position shape", () => {
	const base = { timestamp: "2026-11-22T00:00:00.000Z" };
	const standardAction = { ...base, action_name: "click" };
	const standardObject = {
		...base,
		action_name: "custom_action",
		event_attributes: {
			position: { ordinal: 2 },
			object: { object_id: "1", object_id_type: "product" },
		},
	};
	for (const value of [standardAction, standardObject]) {
		assert.equal(acceptsUbi("strict", "event", value), false);
		assert.equal(acceptsUbi("compat", "event", value), true);
	}

	for (const position of [{}, { ordinal: 2, xy: { x: 1, y: 1 } }]) {
		assert.equal(
			acceptsUbi("compat", "event", {
				...standardObject,
				event_attributes: { ...standardObject.event_attributes, position },
			}),
			false,
		);
	}
	assert.ok(
		acceptsUbi("strict", "event", { ...base, action_name: "custom_action" }),
	);
});

const { profile, sha256 } = compileProfile(
	await readFile(new URL("../examples/shop.toml", import.meta.url), "utf8"),
	"toml",
);

test("checks profile identity, event fields, and timestamps again at intake", () => {
	const uuid = "00000000-0000-4000-8000-000000000000";
	const record = {
		event_id: uuid,
		profile_hash: sha256,
		kind: "event",
		payload: {
			application: profile.application,
			action_name: "add_cart",
			session_id: uuid,
			timestamp: "2026-11-22T00:00:00.000Z",
		},
	};
	assert.equal(validateRecord(record, profile, sha256).event_id, uuid);
	for (const invalid of [
		{ ...record, profile_hash: "wrong" },
		{ ...record, metadata: { undeclared: true } },
		{
			...record,
			payload: { ...record.payload, timestamp: "2026-02-30T00:00:00.000Z" },
		},
		{ ...record, payload: { ...record.payload, user_query: "undeclared" } },
	]) {
		assert.throws(() => validateRecord(invalid, profile, sha256));
	}
});
