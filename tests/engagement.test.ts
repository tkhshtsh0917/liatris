import assert from "node:assert/strict";
import test from "node:test";
import { observeEngagement } from "../src/engagement.ts";

test("caps long absences, skips hidden intervals, and forgets unsent time on revocation", (t) => {
	const tab = new EventTarget();
	const view = new EventTarget();
	const state = Object.assign(tab, {
		visibilityState: "visible",
		hasFocus: () => true,
	});
	for (const [name, value] of Object.entries({
		document: state,
		window: view,
	})) {
		const original = Object.getOwnPropertyDescriptor(globalThis, name);
		Object.defineProperty(globalThis, name, { value, configurable: true });
		t.after(() => {
			if (original) Object.defineProperty(globalThis, name, original);
			else Reflect.deleteProperty(globalThis, name);
		});
	}

	let mono = 0;
	let wall = 0;
	t.mock.method(performance, "now", () => mono);
	t.mock.method(Date, "now", () => wall);
	const consent = new AbortController();
	const reports: number[] = [];
	const tracker = observeEngagement({
		signal: consent.signal,
		idleMs: 60_000,
		onCheckpoint(ms) {
			reports.push(ms);
		},
	});

	mono = wall = 3 * 60 * 60 * 1000;
	tracker.checkpoint();
	assert.deepEqual(reports, [60_000]);

	state.visibilityState = "hidden";
	tab.dispatchEvent(new Event("visibilitychange"));
	mono += 10_000;
	wall += 10_000;
	state.visibilityState = "visible";
	tab.dispatchEvent(new Event("visibilitychange"));
	tracker.checkpoint();
	assert.deepEqual(reports, [60_000]);

	consent.abort();
	tracker.checkpoint();
	assert.deepEqual(reports, [60_000]);
});

test("expires the idle budget when sleep advances the wall clock alone", (t) => {
	const tab = Object.assign(new EventTarget(), {
		visibilityState: "visible",
		hasFocus: () => true,
	});
	for (const [name, value] of Object.entries({
		document: tab,
		window: new EventTarget(),
	})) {
		const original = Object.getOwnPropertyDescriptor(globalThis, name);
		Object.defineProperty(globalThis, name, { value, configurable: true });
		t.after(() => {
			if (original) Object.defineProperty(globalThis, name, original);
			else Reflect.deleteProperty(globalThis, name);
		});
	}

	let mono = 0;
	let wall = 0;
	t.mock.method(performance, "now", () => mono);
	t.mock.method(Date, "now", () => wall);
	const reports: number[] = [];
	const tracker = observeEngagement({
		signal: new AbortController().signal,
		onCheckpoint(ms) {
			reports.push(ms);
		},
	});

	wall += 3 * 60 * 60 * 1_000;
	tracker.checkpoint();
	mono += 2_000;
	wall += 2_000;
	tracker.checkpoint();
	assert.deepEqual(reports, []);
	tracker.close();
});
