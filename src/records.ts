import { readFields, readObject, readString, requireKeys } from "./fields.ts";
import type { Profile } from "./profile.ts";

type Scalars = Record<string, string | number | boolean>;

export type QueryInput = {
	query_id: string;
	user_query: string;
	query_attributes?: Scalars;
};

export type EventInput = {
	query_id?: string;
	event_attributes?: {
		position: { ordinal: number } & Scalars;
		object?: { object_id: string; object_id_type?: string } & Scalars;
	} & Record<string, unknown>;
	metadata?: Scalars;
};

function readPosition(profile: Profile, value: unknown) {
	const { ordinal, ...fields } = readObject(value);
	if (
		typeof ordinal !== "number" ||
		!Number.isSafeInteger(ordinal) ||
		ordinal < 1
	) {
		throw new TypeError("expected a positive displayed rank");
	}
	return {
		...readFields(fields, profile.extensions?.["event_attributes.position"]),
		ordinal,
	};
}

function readResult(profile: Profile, value: unknown) {
	const { object_id, object_id_type, ...fields } = readObject(value);
	return {
		...readFields(fields, profile.extensions?.["event_attributes.object"]),
		object_id: readString(object_id, 1024),
		...(object_id_type === undefined
			? {}
			: { object_id_type: readString(object_id_type, 100) }),
	};
}

function readAttributes(profile: Profile, value: unknown) {
	const { position, object, ...fields } = readObject(value);
	return {
		...readFields(fields, profile.extensions?.event_attributes),
		position: readPosition(profile, position),
		...(object === undefined ? {} : { object: readResult(profile, object) }),
	};
}

/** Checks the query fields the host is permitted to capture. */
export function readQuery(profile: Profile, value: unknown) {
	if (!profile.allowQueryText)
		throw new TypeError("query text capture disabled");

	const input = readObject(value);
	requireKeys(input, ["query_id", "user_query", "query_attributes"]);
	return {
		query_id: readString(input.query_id, 100),
		user_query: readString(input.user_query, 1024, true),
		query_attributes: readFields(
			input.query_attributes,
			profile.extensions?.query_attributes,
		),
	};
}

/** Checks declared event fields and any result coordinates supplied by the host. */
export function readEvent(profile: Profile, name: string, value: unknown) {
	if (!Object.hasOwn(profile.events, name))
		throw new TypeError("undeclared event");

	const input = readObject(value);
	requireKeys(input, ["query_id", "event_attributes", "metadata"]);
	const { query_id, event_attributes, metadata } = input;

	return {
		payload: {
			action_name: name,
			...(query_id === undefined
				? {}
				: { query_id: readString(query_id, 100) }),
			...(event_attributes === undefined
				? {}
				: { event_attributes: readAttributes(profile, event_attributes) }),
		},
		metadata: readFields(metadata, profile.events[name].fields),
	};
}

export type Envelope = {
	event_id: string;
	profile_hash: string;
	kind: "query" | "event";
	payload: Record<string, unknown>;
	metadata?: Scalars;
};

export const maxRecordBytes = 32 * 1024;
