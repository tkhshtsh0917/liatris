/** Scalar types supported in collection profile fields. */
export type FieldRule = { required?: boolean } & (
	| { type: "string"; maxLength: number }
	| { type: "integer" | "number" | "boolean" }
);

export type FieldRules = Record<string, FieldRule>;
export type ExtensionPath =
	| "query_attributes"
	| "event_attributes"
	| "event_attributes.object"
	| "event_attributes.position";

/** The format shared by the browser collector and receiver after compilation. */
export type Profile = {
	version: 1;
	ubiSchema: "1.3.0";
	schemaMode: "strict" | "compat";
	tenant: string;
	application: string;
	endpoint: string;
	allowQueryText: boolean;
	session: { inactivityMinutes: number };
	events: Record<string, { fields?: FieldRules }>;
	extensions?: Partial<Record<ExtensionPath, FieldRules>>;
};
