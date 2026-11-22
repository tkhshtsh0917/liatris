import type { FieldRule, FieldRules } from "./profile.ts";

type Scalar = string | number | boolean;

export function readObject(value: unknown): Record<string, unknown> {
	if (
		typeof value !== "object" ||
		value === null ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null)
	) {
		throw new TypeError("expected a plain object");
	}

	const fields: [string, unknown][] = [];
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key !== "string" || !descriptor || !("value" in descriptor)) {
			throw new TypeError("expected own data properties");
		}
		fields.push([key, descriptor.value]);
	}
	return Object.fromEntries(fields);
}

export function requireKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): void {
	if (Object.keys(value).some((key) => !allowed.includes(key))) {
		throw new TypeError("undeclared field");
	}
}

export function readString(value: unknown, limit: number, allowEmpty = false) {
	if (
		typeof value !== "string" ||
		(!allowEmpty && value.length === 0) ||
		value.length > limit
	) {
		throw new TypeError("invalid string field");
	}
	return value;
}

function matchesRule(value: unknown, rule: FieldRule): value is Scalar {
	switch (rule.type) {
		case "string":
			return typeof value === "string" && value.length <= rule.maxLength;
		case "integer":
			return Number.isSafeInteger(value);
		case "number":
			return Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
	}
}

export function readFields(value: unknown = {}, rules: FieldRules = {}) {
	const input = readObject(value);
	requireKeys(input, Object.keys(rules));

	const result: [string, Scalar][] = [];
	for (const [name, rule] of Object.entries(rules)) {
		if (!Object.hasOwn(input, name)) {
			if (rule.required) throw new TypeError("missing required field");
			continue;
		}
		const item = input[name];
		if (!matchesRule(item, rule)) throw new TypeError("invalid custom field");
		result.push([name, item]);
	}
	return Object.fromEntries(result);
}
