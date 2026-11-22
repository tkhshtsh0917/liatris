import {
	type BatchDelivery,
	batchMediaType,
	readBatchReceipts,
} from "./batch.ts";
import { isBearerToken } from "./bearer.ts";
import type { Delivery } from "./collector.ts";
import { resolveEndpoint } from "./endpoint.ts";

/** Exposes HTTP retry classification without returning response bodies. */
export class HttpDeliveryError extends Error {
	readonly retryable: boolean;
	readonly retryAfterMs: number;

	constructor(status: number, retryAfter: string | null) {
		super(`collection failed (${status})`);
		this.retryable =
			(status >= 200 && status < 300) ||
			status === 408 ||
			status === 429 ||
			status >= 500;
		const seconds = retryAfter === null ? NaN : Number(retryAfter);
		const delay = Number.isFinite(seconds)
			? seconds * 1000
			: Date.parse(retryAfter ?? "") - Date.now();
		this.retryAfterMs = Number.isFinite(delay)
			? Math.max(0, Math.min(3_600_000, delay))
			: 0;
	}
}

type HttpDeliveryOptions = {
	getAccessToken?: (signal: AbortSignal) => Promise<string>;
	requireAcknowledgement?: boolean;
};

function createSender(
	endpoint: string,
	getAccessToken?: HttpDeliveryOptions["getAccessToken"],
) {
	const destination = resolveEndpoint(endpoint, getAccessToken !== undefined);
	return async (body: string, type: string, signal: AbortSignal) => {
		signal.throwIfAborted();
		const headers = new Headers({ "content-type": type });
		if (getAccessToken) {
			const token = await getAccessToken(signal);
			signal.throwIfAborted();
			if (!isBearerToken(token))
				throw new TypeError("invalid collection credential");
			headers.set("authorization", `Bearer ${token}`);
		}

		return fetch(destination, {
			method: "POST",
			headers,
			body,
			credentials: "omit",
			referrerPolicy: "no-referrer",
			redirect: "error",
			signal,
		});
	};
}

/** Sends a single JSON event and optionally requires HTTP 204. */
export function createHttpDelivery(
	endpoint: string,
	{ getAccessToken, requireAcknowledgement = false }: HttpDeliveryOptions = {},
): Delivery {
	const post = createSender(endpoint, getAccessToken);
	return async (record, signal) => {
		const response = await post(
			JSON.stringify(record),
			"application/json",
			signal,
		);
		if (!response.ok || (requireAcknowledgement && response.status !== 204))
			throw new HttpDeliveryError(
				response.status,
				response.headers.get("retry-after"),
			);
	};
}

/** Sends a JSON batch and validates the individual receipts against the request. */
export function createHttpBatchDelivery(
	endpoint: string,
	{ getAccessToken }: Pick<HttpDeliveryOptions, "getAccessToken"> = {},
): BatchDelivery {
	const post = createSender(endpoint, getAccessToken);
	return async (records, signal) => {
		const response = await post(
			JSON.stringify(records),
			batchMediaType,
			signal,
		);
		if (response.status !== 200) {
			throw new HttpDeliveryError(
				response.status,
				response.headers.get("retry-after"),
			);
		}
		const body = response.body;
		if (!body) throw new Error("missing batch receipt");

		const reader = body.getReader();
		const decoder = new TextDecoder("utf-8", { fatal: true });
		let bytes = 0;
		let json = "";
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > 8192) {
					await reader.cancel();
					throw new Error("batch receipt too large");
				}
				json += decoder.decode(value, { stream: true });
			}
			return readBatchReceipts(JSON.parse(json + decoder.decode()), records);
		} finally {
			reader.releaseLock();
		}
	};
}
