import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { createHttpReceiver } from "../server/http.ts";
import { resolveEndpoint } from "../src/endpoint.ts";
import { createHttpDelivery, HttpDeliveryError } from "../src/http-delivery.ts";
import type { Envelope } from "../src/records.ts";
import { compileProfile } from "../tools/profile.ts";

const { profile, sha256 } = compileProfile(
	await readFile(new URL("../examples/shop.toml", import.meta.url), "utf8"),
	"toml",
);

const record: Envelope = {
	event_id: "5e7416de-b981-4596-80cd-c9177805c85a",
	profile_hash: sha256,
	kind: "event",
	payload: {
		action_name: "add_cart",
		application: profile.application,
		timestamp: "2026-11-22T00:00:00.000Z",
		session_id: "45d50fc3-25c7-409c-ae6c-9249b900a701",
	},
};

test("resolves a relative collection path against the actual origin", (t) => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
	t.after(() => {
		if (previous) Object.defineProperty(globalThis, "location", previous);
		else Reflect.deleteProperty(globalThis, "location");
	});

	const setOrigin = (origin: string) => {
		Object.defineProperty(globalThis, "location", {
			configurable: true,
			value: { origin },
		});
	};
	setOrigin("https://store.example");
	assert.equal(
		resolveEndpoint("/api/events", true),
		"https://store.example/api/events",
	);
	setOrigin("http://store.example");
	assert.throws(() => resolveEndpoint("/api/events", false), /HTTPS/);
	setOrigin("http://127.0.0.1:4173");
	assert.equal(
		resolveEndpoint("/api/events", false),
		"http://127.0.0.1:4173/api/events",
	);
	assert.throws(() => resolveEndpoint("/api/events", true), /HTTPS/);

	for (const invalid of [
		"//other.example/collect",
		"https://user:pw@collector.example/",
		"https:///collector.example/",
	]) {
		assert.throws(() => createHttpDelivery(invalid));
	}
});

test("sends only an explicit bearer credential and suppresses ambient credentials, referrer and redirects", async (t) => {
	const fetch = t.mock.method(
		globalThis,
		"fetch",
		async (_url: unknown, _init?: RequestInit) =>
			new Response(null, { status: 204 }),
	);
	const signal = new AbortController().signal;
	const endpoint = "https://collector.example/events";
	const send = createHttpDelivery(endpoint, {
		getAccessToken: async () => "demo-token",
	});
	await send(record, signal);
	await createHttpDelivery(endpoint)(record, signal);

	const [[sentTo, init], [, anonymous]] = fetch.mock.calls.map(
		(call) => call.arguments,
	);
	assert.equal(sentTo, endpoint);
	assert.equal(init?.credentials, "omit");
	assert.equal(init?.referrerPolicy, "no-referrer");
	assert.equal(init?.redirect, "error");
	assert.equal(
		new Headers(init?.headers).get("authorization"),
		"Bearer demo-token",
	);
	assert.equal(new Headers(anonymous?.headers).has("authorization"), false);
});

test("refuses malformed credentials and cancels delivery after an asynchronous token lookup", async (t) => {
	const fetch = t.mock.method(globalThis, "fetch", async () =>
		assert.fail("unexpected fetch"),
	);
	const abort = new AbortController();
	const endpoint = "https://collector.example/events";
	const invalid = createHttpDelivery(endpoint, {
		getAccessToken: async () => "demo-token\n",
	});
	await assert.rejects(
		invalid(record, abort.signal),
		/invalid collection credential/,
	);

	const cancelled = createHttpDelivery(endpoint, {
		async getAccessToken() {
			abort.abort();
			return "demo-token";
		},
	});
	await assert.rejects(cancelled(record, abort.signal), { name: "AbortError" });
	assert.equal(fetch.mock.callCount(), 0);
});

test("requires a verified bearer token with the configured write scope before intake", async (t) => {
	const accepted: Envelope[] = [];
	const audience = "test-collector";
	const grant = {
		tenant: profile.tenant,
		application: profile.application,
		audience,
		permission: "liatris:write",
		expiresAtMs: Date.now() + 60_000,
	};
	const credentials = new Map([
		["scoped-token", grant],
		["other-token", { ...grant, tenant: "other" }],
		["other-app", { ...grant, application: "other" }],
		["expired-token", { ...grant, expiresAtMs: 0 }],
		["other-audience", { ...grant, audience: "elsewhere" }],
		["read-token", { ...grant, permission: "liatris:read" }],
	]);
	const receiver = createHttpReceiver(
		profile,
		sha256,
		async (event) => {
			accepted.push(event);
		},
		{
			audience,
			async verifyBearer(token) {
				if (token === "verifier-outage")
					throw new Error("verification unavailable");
				return credentials.get(token);
			},
		},
	);
	const server = createServer(receiver);
	t.after(() => server.close());
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const endpoint = `http://127.0.0.1:${address.port}`;
	const send = (token: string | undefined, body = "invalid JSON") =>
		fetch(endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token && { authorization: `Bearer ${token}` }),
			},
			body,
		});

	const anonymous = await send(undefined);
	assert.equal(anonymous.status, 401);
	assert.equal(anonymous.headers.get("www-authenticate"), "Bearer");
	assert.equal((await send("invalid-token")).status, 401);
	for (const token of ["expired-token", "other-audience"]) {
		assert.equal((await send(token)).status, 401);
	}
	for (const token of ["other-token", "other-app", "read-token"]) {
		assert.equal((await send(token)).status, 403);
	}
	assert.equal((await send("verifier-outage")).status, 503);
	assert.equal((await send("scoped-token")).status, 400);
	assert.equal(
		(await send("scoped-token", JSON.stringify(record))).status,
		204,
	);
	assert.deepEqual(accepted, [record]);
});

test("durable HTTP delivery waits for the agreed acknowledgement and classifies retryable replies", async (t) => {
	let response = new Response(null, { status: 202 });
	t.mock.method(globalThis, "fetch", async () => response);
	const send = createHttpDelivery("https://collector.example/events", {
		requireAcknowledgement: true,
	});
	const signal = new AbortController().signal;
	const isRetryable = (error: unknown) =>
		error instanceof HttpDeliveryError && error.retryable;
	await assert.rejects(send(record, signal), isRetryable);

	response = new Response(null, {
		status: 429,
		headers: { "retry-after": "30" },
	});
	await assert.rejects(
		send(record, signal),
		(error: unknown) =>
			error instanceof HttpDeliveryError &&
			error.retryable &&
			error.retryAfterMs === 30_000,
	);
	response = new Response(null, { status: 409 });
	await assert.rejects(
		send(record, signal),
		(error: unknown) => error instanceof HttpDeliveryError && !error.retryable,
	);
	response = new Response(null, { status: 204 });
	await send(record, signal);
});
