import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultIdleMs, sessionTransition } from "../src/session.ts";
import { benchmarkBrowser } from "./browser.ts";

async function checkParity(referenceSdk: URL) {
	const bytes = await readFile(new URL("session.wasm", referenceSdk));
	const { instance } = await WebAssembly.instantiate(Uint8Array.from(bytes));
	const wasm = instance.exports as {
		session_default_idle_ms(): number;
		session_transition(now: number, previous: number, idleMs: number): number;
	};
	assert.equal(wasm.session_default_idle_ms(), defaultIdleMs);

	let comparisons = 0;
	function compare(now: number, previous: number, idle: number) {
		assert.equal(
			sessionTransition(now, previous, idle),
			wasm.session_transition(now, previous, idle),
			`session decision differed for ${now}, ${previous}, ${idle}`,
		);
		comparisons++;
	}
	const dateLimit = 8_640_000_000_000_000;
	const timestamps = [
		NaN,
		Infinity,
		-Infinity,
		-2,
		-1,
		-0,
		0,
		0.5,
		60_000,
		300_001,
		1_799_999,
		1_800_000,
		86_400_000,
		dateLimit,
		dateLimit + 1,
	];
	for (const now of timestamps) {
		for (const previous of timestamps) {
			for (const idle of [
				0, 1, 59_999, 60_000, 1_800_000, 86_400_000, 86_400_001,
			])
				compare(now, previous, idle);
		}
	}
	for (let index = 0; index < 10_000; index++) {
		const previous = 1_000_000 + index * 331;
		const boundary = [60_000, 1_800_000, -300_000][index % 3];
		compare(
			previous + boundary + (index % 11) - 5,
			previous,
			index % 2 ? 0 : 60_000,
		);
	}
	console.log(
		JSON.stringify({
			stage: "session-parity",
			comparisons,
			referenceBytes: bytes.length,
		}),
	);
}

export async function benchmarkSessionComparison(
	directory: string | undefined,
) {
	if (!directory) throw new Error("supply an extracted v0.2.0 SDK directory");
	const referenceSdk = pathToFileURL(resolve(directory) + sep);
	await checkParity(referenceSdk);
	for (let trial = 0; trial < 3; trial++) {
		for (const wasmDelayMs of [0, 40]) {
			const reference = { referenceSdk, wasmDelayMs };
			const candidate = { wasmDelayMs };
			const order = trial % 2 ? [candidate, reference] : [reference, candidate];
			for (const options of order) await benchmarkBrowser(options);
		}
	}
}
