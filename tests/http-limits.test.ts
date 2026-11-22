import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
	type ClientRequest,
	createServer,
	type OutgoingHttpHeaders,
	request,
} from "node:http";
import test from "node:test";
import { createHttpReceiver } from "../server/http.ts";
import { maxRecordBytes } from "../src/records.ts";
import { compileProfile } from "../tools/profile.ts";

const { profile, sha256 } = compileProfile(
	await readFile(new URL("../examples/shop.toml", import.meta.url), "utf8"),
	"toml",
);

function post(
	endpoint: string,
	headers: OutgoingHttpHeaders,
	send: (req: ClientRequest) => void,
) {
	return new Promise<number | undefined>((resolve, reject) => {
		const req = request(
			endpoint,
			{
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
			},
			(res) => {
				res.resume();
				res.once("end", () => resolve(res.statusCode));
			},
		);
		req.once("error", reject);
		req.setTimeout(5_000, () =>
			req.destroy(new Error("test request deadline")),
		);
		send(req);
	});
}

test("accepts the byte limit and rejects unusable uploads without waiting for the sender to finish", async (t) => {
	let accepted = 0;
	const server = createServer();
	t.after(() => {
		server.close();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const origin = `http://127.0.0.1:${address.port}`;
	server.on(
		"request",
		createHttpReceiver(
			profile,
			sha256,
			async () => {
				accepted++;
			},
			{
				loopbackOrigin: origin,
				bodyTimeoutMs: 150,
			},
		),
	);

	const body = JSON.stringify({
		event_id: "5e7416de-b981-4596-80cd-c9177805c85a",
		profile_hash: sha256,
		kind: "event",
		payload: {
			action_name: "add_cart",
			application: profile.application,
			timestamp: "2026-11-22T00:00:00.000Z",
			session_id: "45d50fc3-25c7-409c-ae6c-9249b900a701",
		},
	});
	assert.equal(
		await post(origin, {}, (req) => req.end(body.padEnd(maxRecordBytes))),
		204,
	);

	const oversized = { "content-length": maxRecordBytes + 1 };
	assert.equal(await post(origin, oversized, (req) => req.flushHeaders()), 413);
	const streamed = { "transfer-encoding": "chunked" };
	assert.equal(
		await post(origin, streamed, (req) =>
			req.write(" ".repeat(maxRecordBytes + 1)),
		),
		413,
	);
	assert.equal(await post(origin, streamed, (req) => req.write("{")), 408);
	assert.equal(
		await post(origin, { "content-encoding": "gzip" }, (req) =>
			req.flushHeaders(),
		),
		415,
	);
	assert.equal(
		await post(origin, { origin: "https://another.example" }, (req) =>
			req.end(body),
		),
		403,
	);
	assert.equal(
		await post(origin, { host: "another.example" }, (req) => req.end(body)),
		403,
	);
	assert.equal(accepted, 1);
});
