import type { IncomingMessage, ServerResponse } from "node:http";
import type { Profile } from "../src/profile.ts";
import { type Envelope, maxRecordBytes } from "../src/records.ts";
import { validateRecord } from "./validate.ts";

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

function reply(response: ServerResponse, status: number) {
	response.writeHead(status, { "cache-control": "no-store" }).end();
}

/** Receives one bounded JSON record and acknowledges it after the sink accepts it. */
export function createHttpReceiver(
	profile: Profile,
	profileHash: string,
	accept: (record: Envelope) => Promise<void>,
) {
	return async (request: IncomingMessage, response: ServerResponse) => {
		if (request.method !== "POST") {
			response.setHeader("allow", "POST");
			return reply(response, 405);
		}
		if (
			request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
			"application/json"
		) {
			request.resume();
			return reply(response, 415);
		}

		let record: Envelope;
		try {
			const body = await readBoundedBody(request);
			if (body === undefined) {
				response.setHeader("connection", "close");
				return reply(response, 413);
			}
			const value: unknown = JSON.parse(body);
			record = validateRecord(value, profile, profileHash);
		} catch {
			return reply(response, 400);
		}

		try {
			await accept(record);
		} catch {
			return reply(response, 503);
		}
		reply(response, 204);
	};
}
