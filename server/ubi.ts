import { Ajv2020 } from "ajv/dist/2020.js";
import eventSchema from "../schema/upstream/ubi-1.3.0/event.schema.json" with {
	type: "json",
};
import querySchema from "../schema/upstream/ubi-1.3.0/query.request.schema.json" with {
	type: "json",
};
import type { Profile } from "../src/profile.ts";

const compatible = structuredClone(eventSchema);
const { action_name, event_attributes } = compatible.properties;
const { object_id_type } = event_attributes.properties.object.properties;
Object.assign(action_name, action_name.oneOf[1]);
Object.assign(object_id_type, object_id_type.oneOf[1]);
Reflect.deleteProperty(action_name, "oneOf");
Reflect.deleteProperty(object_id_type, "oneOf");

/** Accepts the canonical UTC timestamp emitted by the collector. */
export function isCaptureTime(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
	)
		return false;
	const date = new Date(value);
	return Number.isFinite(date.valueOf()) && date.toISOString() === value;
}

const ajv = new Ajv2020({
	strict: true,
	strictRequired: false,
	strictTypes: false,
	ownProperties: true,
});
ajv.addFormat("date-time", isCaptureTime);
const query = ajv.compile(querySchema);
const events = {
	strict: ajv.compile(eventSchema),
	compat: ajv.compile({
		...compatible,
		$id: "urn:liatris:ubi:1.3.0:compat:event",
	}),
};

/** Applies the profile's selected UBI schema to the payload. */
export function acceptsUbi(
	mode: Profile["schemaMode"],
	kind: "query" | "event",
	payload: unknown,
): boolean {
	return kind === "query" ? query(payload) : events[mode](payload);
}
