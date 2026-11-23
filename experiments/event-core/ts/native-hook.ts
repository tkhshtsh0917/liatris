import { registerHooks } from "node:module";

const receiverValidator = new URL(
	"../../../server/validate.ts",
	import.meta.url,
).href;
const original = new URL("../../../src/records.ts", import.meta.url).href;
const experiment = new URL("./native-records.ts", import.meta.url).href;

export let active = false;

registerHooks({
	resolve(specifier, context, next) {
		const resolved = next(specifier, context);
		// Only benchmark the shape and profile checks in the real receiver.
		if (context.parentURL === receiverValidator && resolved.url === original) {
			active = true;
			return { url: experiment, shortCircuit: true };
		}
		return resolved;
	},
});
