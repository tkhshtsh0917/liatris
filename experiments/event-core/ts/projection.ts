import { readObject } from "../../../src/fields.ts";
import type { Profile } from "../../../src/profile.ts";
import type * as Records from "../../../src/records.ts";

export type Request =
	| { kind: "event"; name: string; data: unknown }
	| { kind: "query"; data: unknown };
type Readers = Pick<typeof Records, "readEvent" | "readQuery">;
type Candidate =
	| ReturnType<Readers["readEvent"]>
	| ReturnType<Readers["readQuery"]>
	| null;
type Project = (text: string) => string | undefined;
type Factory = (profile: Profile) => Project | undefined;

function snapshot(value: unknown, depth = 0): unknown {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" &&
			Number.isFinite(value) &&
			!Object.is(value, -0))
	)
		return value;
	if (depth >= 4 || typeof value !== "object")
		throw new TypeError("outside the JSON projection domain");

	return Object.fromEntries(
		Object.entries(readObject(value)).map(([key, item]) => [
			key,
			snapshot(item, depth + 1),
		]),
	);
}

export function encodeRequests(
	requests: readonly Request[],
): string | undefined {
	if (requests.length < 1 || requests.length > 32) return;
	try {
		return JSON.stringify(
			requests.map((request) => ({ ...request, data: snapshot(request.data) })),
		);
	} catch {
		// Use the current host semantics for values outside the adapter's domain.
		return;
	}
}

export function createRecordReaders(
	reference: Readers,
	factory: Factory,
): Readers {
	const projectors = new WeakMap<Profile, Project | null>();
	function project(profile: Profile, request: Request) {
		let projector = projectors.get(profile);
		if (projector === undefined) {
			projector = factory(profile) ?? null;
			projectors.set(profile, projector);
		}
		if (!projector) return;
		const requestText = encodeRequests([request]);
		if (requestText === undefined) return;
		const response = projector(requestText);
		if (response === undefined) return;
		return (JSON.parse(response) as Candidate[])[0];
	}

	return {
		readEvent(profile, name, data) {
			const result = project(profile, { kind: "event", name, data });
			if (result && "payload" in result) return result;
			return reference.readEvent(profile, name, data);
		},
		readQuery(profile, data) {
			const result = project(profile, { kind: "query", data });
			if (result && "user_query" in result) return result;
			return reference.readQuery(profile, data);
		},
	};
}
