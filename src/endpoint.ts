const relativeOrigin = "https://profile.invalid";

/** Accepts one same-origin path or an explicit HTTPS endpoint. */
export function checkEndpoint(value: string): void {
	if (
		typeof value !== "string" ||
		value.length > 2048 ||
		/[\\?#\s]/.test(value) ||
		value.startsWith("//")
	)
		throw new TypeError("invalid collection endpoint");

	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 32 || code === 127)
			throw new TypeError("invalid collection endpoint");
	}

	const relative = value.startsWith("/");
	const url = new URL(value, relativeOrigin);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		(relative ? url.origin !== relativeOrigin : !/^https:\/\/[^/]/i.test(value))
	) {
		throw new Error(
			"collection endpoint must be a same-origin path or HTTPS URL",
		);
	}
}

/** Resolves relative paths against the actual page origin, bypassing HTML base URLs. */
export function resolveEndpoint(
	endpoint: string,
	authenticated: boolean,
): string {
	checkEndpoint(endpoint);
	const url = endpoint.startsWith("/")
		? new URL(endpoint, globalThis.location?.origin)
		: new URL(endpoint);

	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		url.protocol !== "https:" &&
		(url.protocol !== "http:" || authenticated || !loopback)
	) {
		throw new TypeError(
			"collection requires HTTPS outside anonymous loopback development",
		);
	}
	return url.href;
}
