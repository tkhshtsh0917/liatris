import { isBearerToken } from "./bearer.ts";
import type { Delivery } from "./collector.ts";
import { resolveEndpoint } from "./endpoint.ts";

type HttpDeliveryOptions = {
	getAccessToken?: (signal: AbortSignal) => Promise<string>;
};

/** Sends a JSON record without ambient credentials or a referrer. */
export function createHttpDelivery(
	endpoint: string,
	{ getAccessToken }: HttpDeliveryOptions = {},
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
		if (!response.ok) throw new Error(`collection failed (${response.status})`);
	};
}
