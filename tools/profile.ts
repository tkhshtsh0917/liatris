import { createHash } from "node:crypto";
import { parse as parseToml } from "@decimalturn/toml-patch";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "yaml";
import schema from "../schema/profile.schema.json" with { type: "json" };

import type { Profile } from "../src/profile.ts";

type InputProfile = Omit<
	Profile,
	"session" | "schemaMode" | "allowQueryText"
> & {
	session?: Partial<Profile["session"]>;
	schemaMode?: Profile["schemaMode"];
	allowQueryText?: boolean;
};

const ajv = new Ajv2020({
	strict: true,
	strictRequired: false,
	ownProperties: true,
});
const validator = ajv.compile<InputProfile>(schema);
const relativeOrigin = "https://profile.invalid";

function checkEndpoint(value: string): void {
	if (/\s|\\|[?#]/.test(value) || value.startsWith("//")) {
		throw new Error("invalid collection endpoint");
	}

	const relative = value.startsWith("/");
	const url = new URL(value, relativeOrigin);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		(relative ? url.origin !== relativeOrigin : !/^https:\/\//i.test(value))
	) {
		throw new Error(
			"collection endpoint must be a same-origin path or HTTPS URL",
		);
	}
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (typeof value !== "object" || value === null) return value;

	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
	);
}

const parsers = {
	json: (source: string): unknown => JSON.parse(source),
	yaml: (source: string): unknown =>
		parse(source, { schema: "core", maxAliasCount: 0, uniqueKeys: true }),
	toml: (source: string): unknown => parseToml(source),
};

function checkPlainValues(value: unknown): void {
	if (typeof value !== "object" || value === null) return;
	if (!Array.isArray(value)) {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error("profile values must be JSON-compatible");
		}
	}
	for (const child of Object.values(value)) checkPlainValues(child);
}

/** Compiles a bounded JSON, YAML, or TOML profile into reproducible JSON. */
export function compileProfile(source: string, format: keyof typeof parsers) {
	if (Buffer.byteLength(source) > 64 * 1024)
		throw new Error("profile too large");

	const input = parsers[format](source);
	if (!validator(input)) throw new Error(ajv.errorsText(validator.errors));
	checkPlainValues(input);
	checkEndpoint(input.endpoint);

	const profile: Profile = {
		...input,
		schemaMode: input.schemaMode ?? "strict",
		allowQueryText: input.allowQueryText ?? false,
		session: { inactivityMinutes: input.session?.inactivityMinutes ?? 30 },
	};
	const json = `${JSON.stringify(sortKeys(profile), null, 2)}\n`;
	const sha256 = createHash("sha256").update(json).digest("hex");
	return { profile: JSON.parse(json) as Profile, json, sha256 };
}
