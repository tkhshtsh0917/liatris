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
if (mode === "server" || mode === "server-batch")
	await (await import("./receiver.ts")).benchmarkReceiver(
		mode === "server-batch",
	);
else if (mode === "browser")
	await (await import("./browser.ts")).benchmarkBrowser();
else if (mode === "forwarder")
	await (await import("./forwarder.ts")).benchmarkForwarder();
else
	throw new Error(
		"usage: node benchmarks/delivery.ts server|server-batch|browser|forwarder",
	);
