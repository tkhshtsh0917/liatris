import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { compileProfile, maxProfileBytes } from "./profile.ts";

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

const file = await open(input, constants.O_RDONLY | constants.O_NONBLOCK);
let source: string;
try {
	if (!(await file.stat()).isFile())
		throw new Error("expected a regular profile file");

	const bytes = Buffer.alloc(maxProfileBytes + 1);
	let offset = 0;
	while (offset < bytes.length) {
		const { bytesRead } = await file.read(
			bytes,
			offset,
			bytes.length - offset,
			null,
		);
		if (bytesRead === 0) break;

		offset += bytesRead;
	}
	if (offset > maxProfileBytes) throw new Error("profile too large");

	source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
		bytes.subarray(0, offset),
	);
} finally {
	await file.close();
}
const { json, sha256 } = compileProfile(source, format);
await writeFile(destination, json, { flag: "wx" });
console.log(sha256);
