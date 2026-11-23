import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

type ReplayModule = {
	memory: WebAssembly.Memory;
	session_transition(now: number, previous: number, idle: number): number;
	replay_times(): number;
	replay_outcomes(): number;
	replay(count: number, previous: number, idle: number): number;
};

const scope = new URL("../", import.meta.url);

export async function benchmarkSessionReplay() {
	const dir = await mkdtemp(join(tmpdir(), "liatris-session-replay-"));
	try {
		const wasm = join(dir, "session-replay.wasm");
		execFileSync(
			"rustc",
			[
				"--edition=2024",
				"--crate-type=cdylib",
				"--target=wasm32-unknown-unknown",
				"-Copt-level=s",
				"-Cpanic=abort",
				"-Cstrip=symbols",
				fileURLToPath(new URL("benchmarks/session-replay.rs", scope)),
				"-o",
				wasm,
			],
			{ cwd: fileURLToPath(scope) },
		);
		const bytes = Array.from(await readFile(wasm));
		for (const engine of [chromium, firefox, webkit]) {
			const browser = await engine.launch();
			try {
				const page = await browser.newPage();
				const results = await page.evaluate(async (bytes) => {
					const { instance } = await WebAssembly.instantiate(
						Uint8Array.from(bytes),
					);
					const wasm = instance.exports as unknown as ReplayModule;
					const idle = 1_800_000;
					const samples = Float64Array.from({ length: 32 }, (_, index) => {
						if (index === 10) return Number.NaN;
						if (index === 20) return 1;
						return 10_000_000 + index * 290_000;
					});
					const times = new Float64Array(
						wasm.memory.buffer,
						wasm.replay_times(),
						32,
					);
					const outcomes = new Uint8Array(
						wasm.memory.buffer,
						wasm.replay_outcomes(),
						32,
					);

					function js(now: number, previous: number) {
						if (
							!Number.isInteger(now) ||
							now < 0 ||
							now > 8_640_000_000_000_000
						)
							return 0;
						if (
							previous === -1 ||
							now - previous >= idle ||
							now - previous < -300_000
						)
							return 2;
						return 1;
					}

					function replayOne(
						check: (now: number, previous: number) => number,
						batch: Float64Array,
						previous: number,
					) {
						let checksum = 0;
						for (const now of batch) {
							const decision = check(now, previous);
							checksum = (checksum * 31 + decision) | 0;
							if (decision === 2 || (decision === 1 && now > previous))
								previous = now;
						}
						return checksum + previous;
					}

					function replayBatch(batch: Float64Array, previous: number) {
						times.set(batch);
						const next = wasm.replay(batch.length, previous, idle);
						let checksum = 0;
						for (let i = 0; i < batch.length; i++)
							checksum = (checksum * 31 + outcomes[i]) | 0;
						return checksum + next;
					}

					const cases = {
						js: (batch: Float64Array, previous: number) =>
							replayOne(js, batch, previous),
						wasmScalar: (batch: Float64Array, previous: number) =>
							replayOne(
								(now, last) => wasm.session_transition(now, last, idle),
								batch,
								previous,
							),
						wasmBatch: replayBatch,
					};

					function run(
						test: (batch: Float64Array, previous: number) => number,
						batch: Float64Array,
						rounds: number,
					) {
						let checksum = 0;
						const started = performance.now();
						for (let i = 0; i < rounds; i++) {
							checksum += test(batch, i % 2 === 0 ? -1 : 11_000_000);
						}
						return { elapsed: performance.now() - started, checksum };
					}

					const measurements = [];
					for (const count of [1, 32]) {
						const batch = samples.subarray(0, count);
						const rounds = Math.ceil(4_000_000 / count);
						for (const test of Object.values(cases)) run(test, batch, 20_000);

						for (let trial = 0; trial < 3; trial++) {
							const expected = run(cases.js, batch, 2).checksum;
							const names = Object.keys(cases) as (keyof typeof cases)[];
							for (let i = 0; i < names.length; i++) {
								const name = names[(trial + i) % names.length];
								const test = cases[name];
								const { elapsed, checksum } = run(test, batch, rounds);
								if (checksum !== expected * (rounds / 2))
									throw new Error("session replay semantics differ");
								measurements.push({
									count,
									trial,
									name,
									nsPerEvent: (elapsed * 1e6) / (rounds * count),
								});
							}
						}
					}
					return measurements;
				}, bytes);
				for (const measurement of results)
					console.log(
						JSON.stringify({
							stage: "session-replay",
							engine: engine.name(),
							version: browser.version(),
							wasmBytes: bytes.length,
							...measurement,
						}),
					);
			} finally {
				await browser.close();
			}
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
