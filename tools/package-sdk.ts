import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const output = new URL("dist/sdk/", root);
const files = new URL("liatris-browser/", output);
const archive = "liatris-browser.tar.gz";

await rm(output, { recursive: true, force: true });
execFileSync("tsc", ["-p", "tsconfig.sdk.json"], {
	cwd: fileURLToPath(root),
	stdio: "inherit",
});

await copyFile(
	new URL("target/wasm32-unknown-unknown/release/liatris_session.wasm", root),
	new URL("session.wasm", files),
);
await copyFile(new URL("LICENSE", root), new URL("LICENSE", files));

const { version, license } = JSON.parse(
	await readFile(new URL("package.json", root), "utf8"),
);
await writeFile(
	new URL("package.json", files),
	`${JSON.stringify({ name: "liatris-browser", version, license, private: true, type: "module" }, null, 2)}\n`,
);
execFileSync("tar", ["-czf", archive, "liatris-browser"], {
	cwd: fileURLToPath(output),
	env: { ...process.env, COPYFILE_DISABLE: "1" },
});

const digest = createHash("sha256")
	.update(await readFile(new URL(archive, output)))
	.digest("hex");
await writeFile(new URL("SHA256SUMS", output), `${digest}  ${archive}\n`);
