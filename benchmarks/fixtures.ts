import { readFile } from "node:fs/promises";
import type { Envelope } from "../src/records.ts";
import { compileProfile } from "../tools/profile.ts";

const source = await readFile(
	new URL("../examples/shop.toml", import.meta.url),
	"utf8",
);
export const compiled = compileProfile(source, "toml");

export function percentile(values: number[], fraction: number) {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * fraction) - 1];
}

const { profile, sha256 } = compiled;

export const impression = (): Envelope => ({
	event_id: crypto.randomUUID(),
	profile_hash: sha256,
	kind: "event" as const,
	payload: {
		application: profile.application,
		timestamp: new Date().toISOString(),
		session_id: crypto.randomUUID(),
		query_id: crypto.randomUUID(),
		action_name: "result_impression",
		event_attributes: {
			position: { ordinal: 2 },
			object: { object_id: "sample-item", object_id_type: "product" },
		},
	},
	metadata: { result_set: crypto.randomUUID() },
});
