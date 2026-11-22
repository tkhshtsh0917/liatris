import type { IncomingMessage, ServerResponse } from "node:http";
import {
	type BatchReceipt,
	batchMediaType,
	maxBatchBytes,
	maxBatchEvents,
} from "../src/batch.ts";
import type { Profile } from "../src/profile.ts";
import { type Envelope, maxRecordBytes } from "../src/records.ts";
import { createIntakeAccess, type IntakeAccess } from "./access.ts";
import { EventConflictError } from "./intake-error.ts";
import { validateRecord } from "./validate.ts";

type HttpReceiverOptions = IntakeAccess & { bodyTimeoutMs?: number };
const bodyTimedOut = Symbol("body timed out");

async function readBoundedBody(request: IncomingMessage, maxBytes: number) {
	const chunks: Buffer[] = [];
	let size = 0;

	for await (const chunk of request.iterator({ destroyOnReturn: false })) {
		size += chunk.length;
		if (size > maxBytes) return;
		chunks.push(chunk);
	}

	return new TextDecoder("utf-8", { fatal: true }).decode(
		Buffer.concat(chunks, size),
	);
}

async function readBody(
	request: IncomingMessage,
	timeoutMs: number,
	maxBytes: number,
) {
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<typeof bodyTimedOut>((resolve) => {
		timer = setTimeout(() => resolve(bodyTimedOut), timeoutMs);
	});
	try {
		return await Promise.race([readBoundedBody(request, maxBytes), deadline]);
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

/** Validates bounded JSON requests and reports each event's outcome after storage. */
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
		const mediaType = type?.split(";")[0]?.trim().toLowerCase();
		const batch = mediaType === batchMediaType;
		const maxBytes = batch ? maxBatchBytes : maxRecordBytes;
		if (
			(mediaType !== "application/json" && !batch) ||
			(encoding !== undefined && encoding.trim().toLowerCase() !== "identity")
		)
			return closeWithStatus(response, 415);
		if (Number(declaredLength) > maxBytes)
			return closeWithStatus(response, 413);

		const accessFailure = await checkAccess(request);
		if (accessFailure !== undefined) {
			if (accessFailure === 401)
				response.setHeader("www-authenticate", "Bearer");
			return closeWithStatus(response, accessFailure);
		}

		let value: unknown;
		try {
			const body = await readBody(request, bodyTimeoutMs, maxBytes);
			if (body === bodyTimedOut) return closeWithStatus(response, 408);
			if (body === undefined) return closeWithStatus(response, 413);

			value = JSON.parse(body);
		} catch {
			return reply(response, 400);
		}

		if (batch) {
			const receipts = await acceptBatch(value, profile, profileHash, accept);
			if (!receipts) return reply(response, 400);
			response
				.writeHead(200, {
					"cache-control": "no-store",
					"content-type": "application/json",
				})
				.end(JSON.stringify(receipts));
			return;
		}

		let record: Envelope;
		try {
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

const uuid =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function acceptBatch(
	value: unknown,
	profile: Profile,
	profileHash: string,
	accept: (record: Envelope) => Promise<void>,
): Promise<BatchReceipt[] | undefined> {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.length > maxBatchEvents
	)
		return;
	const ids = new Set<string>();
	for (const item of value) {
		const id: unknown = item?.event_id;
		if (typeof id !== "string" || !uuid.test(id) || ids.has(id)) return;
		ids.add(id);
	}

	const receipts: BatchReceipt[] = [];
	for (const item of value) {
		const event_id = item.event_id as string;
		let record: Envelope;
		try {
			if (Buffer.byteLength(JSON.stringify(item)) > maxRecordBytes)
				throw new RangeError("record too large");
			record = validateRecord(item, profile, profileHash);
		} catch {
			receipts.push({ event_id, status: "rejected" });
			continue;
		}

		try {
			await accept(record);
			receipts.push({ event_id, status: "accepted" });
		} catch (error) {
			receipts.push({
				event_id,
				status: error instanceof EventConflictError ? "rejected" : "retry",
			});
		}
	}
	return receipts;
}
