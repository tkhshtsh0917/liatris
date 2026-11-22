import assert from "node:assert/strict";
import test from "node:test";
import { observeResultImpressions } from "../src/impressions.ts";

class ObserverStub {
	static current: ObserverStub;
	queue: IntersectionObserverEntry[] = [];

	private notify: IntersectionObserverCallback;

	constructor(notify: IntersectionObserverCallback) {
		this.notify = notify;
		ObserverStub.current = this;
	}

	observe() {}
	unobserve() {}
	disconnect() {}

	takeRecords() {
		return this.queue.splice(0);
	}

	emit(...entries: IntersectionObserverEntry[]) {
		this.notify(entries, this as unknown as IntersectionObserver);
	}
}

function observation(
	target: Element,
	ratio: number,
): IntersectionObserverEntry {
	return {
		target,
		boundingClientRect: { width: 100, height: 100 },
		isIntersecting: true,
		intersectionRatio: Math.fround(ratio),
	} as IntersectionObserverEntry;
}

test("ignores background and recycled observations and accepts the exact threshold once", (t) => {
	const tab = Object.assign(new EventTarget(), { visibilityState: "visible" });
	for (const [name, value] of Object.entries({
		document: tab,
		IntersectionObserver: ObserverStub,
	})) {
		const original = Object.getOwnPropertyDescriptor(globalThis, name);
		Object.defineProperty(globalThis, name, { value, configurable: true });
		t.after(() => {
			if (original) Object.defineProperty(globalThis, name, original);
			else Reflect.deleteProperty(globalThis, name);
		});
	}

	const ordinals: number[] = [];
	const card = { isConnected: true } as Element;
	const observer = observeResultImpressions(
		{ minVisiblePercent: 70 },
		(ordinal) => {
			ordinals.push(ordinal);
		},
	);
	const initial = ObserverStub.current;
	observer.observe(card, 1);
	initial.emit(observation(card, 0.69));
	assert.deepEqual(ordinals, []);

	tab.visibilityState = "hidden";
	tab.dispatchEvent(new Event("visibilitychange"));
	initial.emit(observation(card, 1));
	assert.deepEqual(ordinals, []);

	tab.visibilityState = "visible";
	tab.dispatchEvent(new Event("visibilitychange"));
	const resumed = ObserverStub.current;
	resumed.queue.push(observation(card, 1));
	observer.observe(card, 2);
	resumed.emit(...resumed.takeRecords());
	initial.emit(observation(card, 1));
	assert.deepEqual(ordinals, []);

	resumed.emit(observation(card, 0.7), observation(card, 0.7));
	assert.deepEqual(ordinals, [2]);

	observer.close();
	resumed.emit(observation(card, 1));
	assert.deepEqual(ordinals, [2]);
});
