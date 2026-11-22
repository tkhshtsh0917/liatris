import type { IncomingMessage, ServerResponse } from "node:http";
import type { Profile } from "../src/profile.ts";
import { type Envelope, maxRecordBytes } from "../src/records.ts";
import { createIntakeAccess, type IntakeAccess } from "./access.ts";
import { EventConflictError } from "./intake-error.ts";
import { validateRecord } from "./validate.ts";

type HttpReceiverOptions = IntakeAccess & { bodyTimeoutMs?: number };
const bodyTimedOut = Symbol("body timed out");

async function readBoundedBody(request: IncomingMessage) {
	const chunks: Buffer[] = [];
	let size = 0;

	for await (const chunk of request.iterator({ destroyOnReturn: false })) {
		size += chunk.length;
		if (size > maxRecordBytes) return;
		chunks.push(chunk);
	}

	return new TextDecoder("utf-8", { fatal: true }).decode(
		Buffer.concat(chunks, size),
	);
}

async function readBody(request: IncomingMessage, timeoutMs: number) {
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<typeof bodyTimedOut>((resolve) => {
		timer = setTimeout(() => resolve(bodyTimedOut), timeoutMs);
	});
	try {
		return await Promise.race([readBoundedBody(request), deadline]);
	} finally {
		clearTimeout(timer);
	}
}

function reply(response: ServerResponse, status: number) {
	response.writeHead(status, { "cache-control": "no-store" }).end();
}

function closeWithStatus(response: ServerResponse, status: number) {
	response.setHeader("connection", "close");
	reply(response, status);
}

/** Receives one bounded JSON record and acknowledges it after the sink accepts it. */
export function createHttpReceiver(
	profile: Profile,
	profileHash: string,
	accept: (record: Envelope) => Promise<void>,
	options: HttpReceiverOptions,
) {
	const checkAccess = createIntakeAccess(profile, options);
	const bodyTimeoutMs = options.bodyTimeoutMs ?? 10_000;
	if (
		!Number.isInteger(bodyTimeoutMs) ||
		bodyTimeoutMs < 1 ||
		bodyTimeoutMs > 60_000
	) {
		throw new RangeError(
			"body timeout must be between 1 and 60000 milliseconds",
		);
	}

	return async (request: IncomingMessage, response: ServerResponse) => {
		if (request.method !== "POST") {
			response.setHeader("allow", "POST");
			return closeWithStatus(response, 405);
		}

		const {
			"content-type": type,
			"content-encoding": encoding,
			"content-length": declaredLength,
		} = request.headers;
		if (
			type?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
			(encoding !== undefined && encoding.trim().toLowerCase() !== "identity")
		)
			return closeWithStatus(response, 415);
		if (Number(declaredLength) > maxRecordBytes)
			return closeWithStatus(response, 413);

		const accessFailure = await checkAccess(request);
		if (accessFailure !== undefined) {
			if (accessFailure === 401)
				response.setHeader("www-authenticate", "Bearer");
			return closeWithStatus(response, accessFailure);
		}

		let record: Envelope;
		try {
			const body = await readBody(request, bodyTimeoutMs);
			if (body === bodyTimedOut) return closeWithStatus(response, 408);
			if (body === undefined) return closeWithStatus(response, 413);

			const value: unknown = JSON.parse(body);
			record = validateRecord(value, profile, profileHash);
		} catch {
			return reply(response, 400);
		}

		try {
			await accept(record);
		} catch (error) {
			return reply(response, error instanceof EventConflictError ? 409 : 503);
		}
		reply(response, 204);
	};
}
