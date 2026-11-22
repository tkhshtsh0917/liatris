import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { openEventStore } from "../server/event-store.ts";
import { createHttpReceiver } from "../server/http.ts";
import { compileProfile } from "../tools/profile.ts";

const port = Number(process.env.LIATRIS_DEMO_PORT ?? "4173");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
	throw new RangeError("invalid demo port");
}
const origin = `http://127.0.0.1:${port}`;

const { profile, sha256 } = compileProfile(
	await readFile(new URL("../examples/shop.toml", import.meta.url), "utf8"),
	"toml",
);

const store = openEventStore(
	process.env.LIATRIS_DB ?? "liatris-demo.sqlite",
	profile,
);
const receive = createHttpReceiver(
	profile,
	sha256,
	async (record) => {
		await store.accept(record);

		console.log("accepted", record.kind, record.payload.action_name ?? "query");
	},
	{ loopbackOrigin: origin },
);
const files = new Map([
	["/", ["./index.html", "text/html; charset=utf-8"]],
	[
		"/session.wasm",
		[
			"../target/wasm32-unknown-unknown/release/liatris_session.wasm",
			"application/wasm",
		],
	],
	[
		"/assets/demo/browser.js",
		["../dist/demo/demo/browser.js", "text/javascript"],
	],
]);
for (const name of [
	"bearer",
	"collector",
	"endpoint",
	"engagement",
	"fields",
	"impressions",
	"outbox-storage",
	"queued-delivery",
	"http-delivery",
	"profile",
	"records",
	"search-measurement",
	"session",
	"session-store",
]) {
	files.set(`/assets/src/${name}.js`, [
		`../dist/demo/src/${name}.js`,
		"text/javascript",
	]);
}

const pagePolicy = [
	"default-src 'none'",
	"script-src 'self' 'wasm-unsafe-eval'",
	"connect-src 'self'",
	"base-uri 'none'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join("; ");

const server = createServer(
	{ headersTimeout: 5_000, requestTimeout: 15_000, maxHeaderSize: 8192 },
	async (request, response) => {
		response.setHeader("x-content-type-options", "nosniff");
		response.setHeader("cache-control", "no-store");
		response.setHeader("referrer-policy", "no-referrer");

		if (request.headers.host !== new URL(origin).host) {
			response.writeHead(403, { connection: "close" }).end();
			return;
		}

		if (request.url === profile.endpoint) {
			await receive(request, response);
			return;
		}
		if (request.method !== "GET") {
			response.writeHead(405, { allow: "GET" }).end();
			return;
		}
		if (request.url === "/demo-config.json") {
			response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ profile, sha256 }));
			return;
		}

		const asset = files.get(request.url ?? "");
		if (!asset) {
			response.writeHead(404).end();
			return;
		}
		try {
			const body = await readFile(new URL(asset[0], import.meta.url));
			if (request.url === "/")
				response.setHeader("content-security-policy", pagePolicy);
			response.writeHead(200, { "content-type": asset[1] }).end(body);
		} catch {
			response.writeHead(503).end();
		}
	},
);
server.listen(port, "127.0.0.1", () => console.log(origin));
server.on("close", () => store.close());
