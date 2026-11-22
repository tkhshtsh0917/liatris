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

/** Sends a JSON record without ambient credentials or a referrer. */
export function createHttpDelivery(
	endpoint: string,
	{ getAccessToken, requireAcknowledgement = false }: HttpDeliveryOptions = {},
): Delivery {
	const destination = resolveEndpoint(endpoint, getAccessToken !== undefined);

	return async (record, signal) => {
		signal.throwIfAborted();
		const headers = new Headers({ "content-type": "application/json" });
		if (getAccessToken) {
			const token = await getAccessToken(signal);
			signal.throwIfAborted();
			if (!isBearerToken(token))
				throw new TypeError("invalid collection credential");
			headers.set("authorization", `Bearer ${token}`);
		}

		const response = await fetch(destination, {
			method: "POST",
			headers,
			body: JSON.stringify(record),
			credentials: "omit",
			referrerPolicy: "no-referrer",
			redirect: "error",
			signal,
		});
		if (!response.ok || (requireAcknowledgement && response.status !== 204))
			throw new HttpDeliveryError(
				response.status,
				response.headers.get("retry-after"),
			);
	};
}
