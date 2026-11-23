import { arch, cpus, platform } from "node:os";

const mode = process.argv[2];
console.log(
	JSON.stringify({
		stage: "environment",
		node: process.version,
		platform: platform(),
		arch: arch(),
		cpu: cpus()[0]?.model,
		cores: cpus().length,
	}),
);
if (mode === "server-batch-native") {
	const hook = await import("../experiments/event-core/ts/native-hook.ts");
	const receiver = await import("./receiver.ts");
	if (!hook.active) throw new Error("native projection hook did not load");
	await receiver.benchmarkReceiver(true);
} else if (mode === "server" || mode === "server-batch")
	await (await import("./receiver.ts")).benchmarkReceiver(
		mode === "server-batch",
	);
else if (mode === "browser" || mode === "browser-rust")
	await (await import("./browser.ts")).benchmarkBrowser(
		mode === "browser-rust",
	);
else if (mode === "event-projection")
	await (
		await import("../experiments/event-core/ts/benchmark.ts")
	).benchmarkProjection();
else if (mode === "session-replay")
	await (await import("./session-replay.ts")).benchmarkSessionReplay();
else if (mode === "forwarder")
	await (await import("./forwarder.ts")).benchmarkForwarder();
else
	throw new Error(
		"usage: node benchmarks/delivery.ts server|server-batch|server-batch-native|browser|browser-rust|event-projection|session-replay|forwarder",
	);
