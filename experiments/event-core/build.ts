import { execFileSync } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dir = new URL("./", import.meta.url);
const root = fileURLToPath(new URL("../../", import.meta.url));
const options = { cwd: fileURLToPath(dir), stdio: "inherit" as const };
const cargo = ["build", "--locked", "--release", "--target-dir", "target"];

execFileSync("cargo", [...cargo, "--features", "native-addon"], options);
execFileSync(
	"cargo",
	[...cargo, "--target", "wasm32-unknown-unknown"],
	options,
);
execFileSync("tsc", ["-p", "experiments/event-core/tsconfig.browser.json"], {
	cwd: root,
	stdio: "inherit",
});

const library =
	process.platform === "win32"
		? "liatris_event_core_experiment.dll"
		: `libliatris_event_core_experiment.${process.platform === "darwin" ? "dylib" : "so"}`;
await copyFile(
	new URL(`target/release/${library}`, dir),
	new URL("target/release/liatris-event-core.node", dir),
);
