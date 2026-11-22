import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { compileProfile } from "./profile.ts";

const [input, destination, extra] = process.argv.slice(2);
if (!input || !destination || extra) {
	throw new Error(
		"Usage: npm run profile -- <profile.json|profile.yaml|profile.toml> <output.json>",
	);
}

const extension = extname(input).toLowerCase();
const formats = new Map<string, "json" | "yaml" | "toml">([
	[".json", "json"],
	[".yaml", "yaml"],
	[".yml", "yaml"],
	[".toml", "toml"],
]);
const format = formats.get(extension);
if (!format) {
	throw new Error("expected a JSON, YAML, or TOML source");
}

const source = await readFile(input, "utf8");
const { json, sha256 } = compileProfile(source, format);
await writeFile(destination, json, { flag: "wx" });
console.log(sha256);
