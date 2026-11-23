import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSessionManager } from "../src/session.ts";
import { memorySessionStore } from "../src/session-store.ts";

const wasm = await readFile(
	new URL(
		"../target/wasm32-unknown-unknown/release/liatris_session.wasm",
		import.meta.url,
	),
);
const scope = { tenant: "test", application: "search" };

test("assigns a UUID and renews after 30 minutes since the last activity", async () => {
	const manager = await createSessionManager(wasm, memorySessionStore(), scope);
	const first = await manager.recordActivity(1_000);
	assert.match(first.sessionId, /^[0-9a-f-]{36}$/);
	assert.equal(first.sessionNumber, 1);
	assert.equal(first.started, true);

	const within = await manager.recordActivity(1_800_999);
	assert.equal(within.sessionId, first.sessionId);
	assert.equal(within.started, false);
	assert.equal(within.startedAtMs, 1_000);

	const next = await manager.recordActivity(3_600_999);
	assert.notEqual(next.sessionId, first.sessionId);
	assert.equal(next.sessionNumber, 2);
});

test("one shared scope reuses state and removal starts a fresh lifetime", async () => {
	const store = memorySessionStore();
	const first = await createSessionManager(wasm, store, scope, 5);
	const second = await createSessionManager(wasm, store, scope, 5);
	const other = await createSessionManager(wasm, store, {
		...scope,
		application: "autocomplete",
	});

	const [a, b, c] = await Promise.all([
		first.recordActivity(0),
		second.recordActivity(0),
		other.recordActivity(0),
	]);
	assert.equal(a.sessionId, b.sessionId);
	assert.equal(Number(a.started) + Number(b.started), 1);
	assert.notEqual(c.sessionId, a.sessionId);

	await first.clear();
	const restarted = await second.recordActivity(100);
	assert.notEqual(restarted.sessionId, a.sessionId);
	assert.equal(restarted.sessionNumber, 1);
});

test("recovers from a rejected timestamp and clamps small clock reversals", async () => {
	const manager = await createSessionManager(
		wasm,
		memorySessionStore(),
		scope,
		1,
	);
	const first = await manager.recordActivity(1_000);
	await assert.rejects(manager.recordActivity(Number.NaN), RangeError);
	assert.equal((await manager.recordActivity(0)).sessionId, first.sessionId);
	assert.equal(
		(await manager.recordActivity(60_000)).sessionId,
		first.sessionId,
	);
	await assert.rejects(
		createSessionManager(wasm, memorySessionStore(), scope, 0),
		RangeError,
	);
});

test("starts a new WASM session at the configured inactivity boundary", async () => {
	const manager = await createSessionManager(
		wasm,
		memorySessionStore(),
		scope,
		15,
	);
	const first = await manager.recordActivity(0);
	const latest = await manager.recordActivity(899_999);
	assert.equal(latest.sessionId, first.sessionId);

	const next = await manager.recordActivity(1_799_999);
	assert.notEqual(next.sessionId, first.sessionId);
	assert.equal(next.sessionNumber, 2);
});

test("batches ordered activities across a session boundary and isolates invalid timestamps", async () => {
	const store = memorySessionStore();
	const manager = await createSessionManager(wasm, store, scope, 1);
	let transactions = 0;
	const update = store.update;
	store.update = (key, next) => {
		transactions++;
		return update(key, next);
	};

	const outcomes = await manager.recordActivities([
		1_000,
		500,
		Number.NaN,
		61_000,
		61_001,
	]);
	assert.equal(transactions, 1);
	const [first, earlier, invalid, later, latest] = outcomes;
	assert.ok("activity" in first && "activity" in earlier);
	assert.ok("error" in invalid && invalid.error instanceof RangeError);
	assert.ok("activity" in later && "activity" in latest);
	assert.equal(first.activity.sessionId, earlier.activity.sessionId);
	assert.notEqual(first.activity.sessionId, later.activity.sessionId);
	assert.equal(later.activity.sessionId, latest.activity.sessionId);
	assert.equal(later.activity.started, true);
	assert.equal(latest.activity.started, false);
	assert.equal(
		(await manager.recordActivity(61_002)).sessionId,
		latest.activity.sessionId,
	);
});
