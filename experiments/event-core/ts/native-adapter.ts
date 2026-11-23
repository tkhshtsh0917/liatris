import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Profile } from "../../../src/profile.ts";

type Host = {
	EventCore: new (
		profile: Buffer,
	) => { project(requests: Buffer): Buffer | undefined };
};

const require = createRequire(import.meta.url);
const { EventCore } = require(
	fileURLToPath(
		new URL("../target/release/liatris-event-core.node", import.meta.url),
	),
) as Host;

export function nativeFactory(profile: Profile) {
	try {
		const core = new EventCore(Buffer.from(JSON.stringify(profile)));
		return (text: string) => core.project(Buffer.from(text))?.toString("utf8");
	} catch {
		return undefined;
	}
}
