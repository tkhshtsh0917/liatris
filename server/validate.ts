import { readObject, requireKeys } from "../src/fields.ts";
import type { Profile } from "../src/profile.ts";
import { type Envelope, readEvent, readQuery } from "../src/records.ts";
import { acceptsUbi, isCaptureTime } from "./ubi.ts";

const uuid =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV4(value: unknown): value is string {
	return typeof value === "string" && uuid.test(value);
}

function checkQuery(
	profile: Profile,
	payload: Record<string, unknown>,
	metadata: unknown,
) {
	if (metadata !== undefined)
		throw new TypeError("query metadata is unsupported");

	const { query_attributes, ...rest } = payload;
	const { session_id, ...fields } = readObject(query_attributes);
	if (!isUuidV4(session_id)) throw new TypeError("invalid query session");

	readQuery(profile, { ...rest, query_attributes: fields });
}

function checkEvent(
	profile: Profile,
	payload: Record<string, unknown>,
	metadata: unknown,
) {
	const { session_id, action_name, ...rest } = payload;
	if (!isUuidV4(session_id) || typeof action_name !== "string") {
		throw new TypeError("invalid event session or name");
	}

	readEvent(profile, action_name, { ...rest, metadata });
}

/** Rechecks the application contract and then the selected UBI schema. */
export function validateRecord(
	value: unknown,
	profile: Profile,
	profileHash: string,
): Envelope {
	const record = readObject(value);
	requireKeys(record, [
		"event_id",
		"profile_hash",
		"kind",
		"payload",
		"metadata",
	]);

	const { event_id, profile_hash, kind, metadata } = record;
	if (
		!isUuidV4(event_id) ||
		profile_hash !== profileHash ||
		(kind !== "query" && kind !== "event")
	) {
		throw new TypeError("invalid collection envelope");
	}

	const payload = readObject(record.payload);
	const { application, timestamp, ...fields } = payload;
	if (application !== profile.application || !isCaptureTime(timestamp)) {
		throw new TypeError("invalid source or capture timestamp");
	}
	if (kind === "query") checkQuery(profile, fields, metadata);
	else checkEvent(profile, fields, metadata);
	if (!acceptsUbi(profile.schemaMode, kind, payload)) {
		throw new TypeError("payload rejected by UBI schema");
	}

	return {
		event_id,
		profile_hash,
		kind,
		payload,
		...(metadata === undefined
			? {}
			: { metadata: metadata as Envelope["metadata"] }),
	};
}
