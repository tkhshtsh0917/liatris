import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
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

const receive = createHttpReceiver(profile, sha256, async (record) => {
	console.log(JSON.stringify(record));
});
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
	"collector",
	"fields",
	"records",
	"session",
	"session-store",
]) {
	files.set(`/assets/src/${name}.js`, [
		`../dist/demo/src/${name}.js`,
		"text/javascript",
	]);
}

const server = createServer(async (request, response) => {
	response.setHeader("x-content-type-options", "nosniff");
	response.setHeader("cache-control", "no-store");

	if (request.url === profile.endpoint) {
		if (request.headers.origin && request.headers.origin !== origin) {
			response.writeHead(403).end();
			return;
		}
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
		response.writeHead(200, { "content-type": asset[1] }).end(body);
	} catch {
		response.writeHead(503).end();
	}
});
server.listen(port, "127.0.0.1", () => console.log(origin));
