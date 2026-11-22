import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compileProfile } from "../tools/profile.ts";

const yaml = await readFile(
	new URL("../examples/shop.yaml", import.meta.url),
	"utf8",
);
const toml = await readFile(
	new URL("../examples/shop.toml", import.meta.url),
	"utf8",
);
const input = JSON.parse(compileProfile(yaml, "yaml").json);
const compile = (changes: object) =>
	compileProfile(JSON.stringify({ ...input, ...changes }), "json");

test("produces identical artifacts from JSON, YAML, and TOML", () => {
	const original = compileProfile(yaml, "yaml");
	assert.deepEqual(compile({}), original);
	assert.deepEqual(compileProfile(toml, "toml"), original);
	assert.equal(input.session.inactivityMinutes, 30);
});

test("rejects invalid TOML and values outside the profile format", () => {
	assert.throws(() => compileProfile(`version = 1\n${toml}`, "toml"));
	const timestampAsSession = toml.replace(
		'endpoint = "/api/ubi"',
		'endpoint = "/api/ubi"\nsession = 2026-01-01',
	);
	assert.throws(
		() => compileProfile(timestampAsSession, "toml"),
		/JSON-compatible/,
	);
});

test("rejects reserved fields, unrecognized locations, and unbounded strings", () => {
	for (const extensions of [
		{ event_attributes: { position: { type: "integer" } } },
		{ "event_attributes.object": { object_id: { type: "integer" } } },
		{ query_attributes: { session_id: { type: "boolean" } } },
		{ root: { experiment_id: { type: "integer" } } },
		{ query_attributes: { text: { type: "string" } } },
	]) {
		assert.throws(() => compile({ extensions }));
	}
});

test("accepts a same-origin path or HTTPS URL and rejects ambiguous destinations", () => {
	assert.equal(
		JSON.parse(compile({ endpoint: "https://collect.example.com/ubi" }).json)
			.endpoint,
		"https://collect.example.com/ubi",
	);
	for (const endpoint of [
		"//other.example.com/a",
		"/\\other.example.com",
		"http://example.com",
		"https://user:secret@example.com",
		"/a?token=value",
		"https://example.com/#frag",
	]) {
		assert.throws(() => compile({ endpoint }));
	}
});

test("rejects YAML aliases and duplicate keys", () => {
	assert.throws(
		() => compileProfile("a: &value [1]\nb: *value", "yaml"),
		/alias/i,
	);
	assert.throws(
		() => compileProfile(`${yaml}\nversion: 1\n`, "yaml"),
		/unique/i,
	);
});
