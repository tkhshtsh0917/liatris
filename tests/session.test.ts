import assert from "node:assert/strict";
import test from "node:test";
import { createSessionManager, sessionTransition } from "../src/session.ts";
import { memorySessionStore } from "../src/session-store.ts";

const scope = { tenant: "test", application: "search" };

test("matches the timeout, clock rollback and invalid-input boundaries", () => {
	const maxDate = 8_640_000_000_000_000;
	assert.equal(sessionTransition(0, -1, 0), 2);
	assert.equal(sessionTransition(1_799_999, 0, 0), 1);
	assert.equal(sessionTransition(1_800_000, 0, 0), 2);
	assert.equal(sessionTransition(60_000, 0, 60_000), 2);
	assert.equal(sessionTransition(0, 300_000, 0), 1);
	assert.equal(sessionTransition(0, 300_001, 0), 2);
	assert.equal(sessionTransition(maxDate, -1, 0), 2);
	assert.equal(sessionTransition(maxDate + 1, -1, 0), 0);
	assert.equal(sessionTransition(Number.NaN, 1, 0), 0);
	assert.equal(sessionTransition(1, Number.POSITIVE_INFINITY, 0), 0);
	assert.equal(sessionTransition(1, -2, 0), 0);
	assert.equal(sessionTransition(1, -1, 1), 0);
	assert.equal(sessionTransition(1, -1, 86_400_001), 0);
});

test("assigns a UUID and renews after 30 minutes since the last activity", async () => {
	const manager = createSessionManager(memorySessionStore(), scope);
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
	const first = createSessionManager(store, scope, 5);
	const second = createSessionManager(store, scope, 5);
	const other = createSessionManager(store, {
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
	const manager = createSessionManager(memorySessionStore(), scope, 1);
	const first = await manager.recordActivity(1_000);
	await assert.rejects(manager.recordActivity(Number.NaN), RangeError);
	assert.equal((await manager.recordActivity(0)).sessionId, first.sessionId);
	assert.equal(
		(await manager.recordActivity(60_000)).sessionId,
		first.sessionId,
	);
	assert.throws(
		() => createSessionManager(memorySessionStore(), scope, 0),
		RangeError,
	);
});

test("starts a new session at the configured inactivity boundary", async () => {
	const manager = createSessionManager(memorySessionStore(), scope, 15);
	const first = await manager.recordActivity(0);
	const latest = await manager.recordActivity(899_999);
	assert.equal(latest.sessionId, first.sessionId);

	const next = await manager.recordActivity(1_799_999);
	assert.notEqual(next.sessionId, first.sessionId);
	assert.equal(next.sessionNumber, 2);
});

test("batches ordered activities across a session boundary and isolates invalid timestamps", async () => {
	const store = memorySessionStore();
	const manager = createSessionManager(store, scope, 1);
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
