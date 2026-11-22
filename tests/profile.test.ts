import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

test("normalizes visibility and accepts custom visibility and session settings across formats", () => {
	assert.equal(input.impressions.minVisiblePercent, 50);

	const impressions = { minVisiblePercent: 70 };
	const session = { inactivityMinutes: 15 };
	const expected = compile({ impressions, session });
	assert.deepEqual(
		compileProfile(
			`${toml}\n[impressions]\nminVisiblePercent = 70\n[session]\ninactivityMinutes = 15\n`,
			"toml",
		),
		expected,
	);
	assert.deepEqual(
		compileProfile(
			`${yaml}\nimpressions: { minVisiblePercent: 70 }\nsession: { inactivityMinutes: 15 }\n`,
			"yaml",
		),
		expected,
	);
	assert.deepEqual(expected.profile.impressions, impressions);
	assert.deepEqual(expected.profile.session, session);

	for (const minVisiblePercent of [0, 101, 70.5, "70"]) {
		assert.throws(() => compile({ impressions: { minVisiblePercent } }));
	}
	for (const inactivityMinutes of [0, 1441, 30.5, "30"]) {
		assert.throws(() => compile({ session: { inactivityMinutes } }));
	}
});

test("the CLI reads at most the profile limit plus one byte", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "liatris-profile-"));
	t.after(() => rm(directory, { recursive: true }));
	const input = join(directory, "source.json");
	const output = join(directory, "compiled.json");
	const cli = fileURLToPath(
		new URL("../tools/compile-profile.ts", import.meta.url),
	);
	const run = () =>
		spawnSync(process.execPath, [cli, input, output], { encoding: "utf8" });

	const exact = compileProfile(yaml, "yaml").json.padEnd(64 * 1024);
	await writeFile(input, `${exact} `);
	const rejected = run();
	assert.equal(rejected.status, 1);
	assert.match(rejected.stderr, /profile too large/);
	await assert.rejects(readFile(output), { code: "ENOENT" });

	await writeFile(input, exact);
	const accepted = run();
	assert.equal(accepted.status, 0, accepted.stderr);
	assert.equal(
		await readFile(output, "utf8"),
		compileProfile(yaml, "yaml").json,
	);
});
