import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { openEventStore } from "../../server/event-store.ts";
import { createHttpReceiver } from "../../server/http.ts";
import type { Profile } from "../../src/profile.ts";

const root = new URL("../../", import.meta.url);
const example = new URL("examples/browser/", root);
const dist = new URL("dist/sdk/", root);
const archive = new URL("liatris-browser.tar.gz", dist);

async function loadSite(directory: string) {
	const checksum = await readFile(new URL("SHA256SUMS", dist), "utf8");
	const digest = createHash("sha256")
		.update(await readFile(archive))
		.digest("hex");
	assert.equal(checksum, `${digest}  liatris-browser.tar.gz\n`);
	execFileSync("tar", ["-xzf", fileURLToPath(archive), "-C", directory]);
	const sdk = join(directory, "liatris-browser");
	const license = await readFile(new URL("LICENSE", root), "utf8");
	assert.equal(await readFile(join(sdk, "LICENSE"), "utf8"), license);
	const manifest = JSON.parse(
		await readFile(join(sdk, "package.json"), "utf8"),
	);
	assert.equal(manifest.license, "MIT");

	const app = await readFile(new URL("app.mjs", example), "utf8");
	const typeFixture = join(directory, "app.mjs");
	await writeFile(
		typeFixture,
		app.replaceAll('"/assets/liatris/', '"./liatris-browser/'),
	);
	execFileSync(
		"tsc",
		[
			"--noEmit",
			"--strict",
			"--allowJs",
			"--checkJs",
			"--target",
			"es2024",
			"--module",
			"nodenext",
			typeFixture,
		],
		{ cwd: directory, stdio: "inherit" },
	);

	const profilePath = join(directory, "profile.json");
	const hash = execFileSync(
		process.execPath,
		[
			fileURLToPath(new URL("tools/compile-profile.ts", root)),
			fileURLToPath(new URL("examples/browser/profile.toml", root)),
			profilePath,
		],
		{ encoding: "utf8" },
	).trim();
	const json = await readFile(profilePath, "utf8");
	const profile = JSON.parse(json) as Profile;
	const assets = new Map<string, { type: string; body: Buffer | string }>([
		[
			"/",
			{
				type: "text/html",
				body: await readFile(new URL("index.html", example)),
			},
		],
		[
			"/app.mjs",
			{
				type: "text/javascript",
				body: app,
			},
		],
		["/assets/liatris/profile.json", { type: "application/json", body: json }],
		["/assets/liatris/profile.sha256", { type: "text/plain", body: hash }],
	]);
	for (const file of await readdir(sdk)) {
		const type = file.endsWith(".js")
			? "text/javascript"
			: file === "session.wasm"
				? "application/wasm"
				: undefined;
		if (type)
			assets.set(`/assets/liatris/${file}`, {
				type,
				body: await readFile(join(sdk, file)),
			});
	}
	return { assets, profile, hash };
}

test("an independent site captures a search using only the extracted SDK", {
	timeout: 30_000,
}, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "liatris-release-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await mkdir(join(directory, "intake"));
	const { assets, profile, hash } = await loadSite(directory);
	const store = openEventStore(
		join(directory, "intake", "events.sqlite"),
		profile,
	);
	const server = createServer();
	t.after(() => {
		server.close();
		store.close();
	});
	const listening = once(server, "listening");
	server.listen(0, "127.0.0.1");
	await listening;
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const origin = `http://127.0.0.1:${address.port}`;
	const receive = createHttpReceiver(profile, hash, store.accept, {
		loopbackOrigin: origin,
		acceptBatch: store.acceptBatch,
	});
	server.on("request", (request: IncomingMessage, response: ServerResponse) => {
		if (request.url === profile.endpoint) return receive(request, response);
		const asset =
			request.method === "GET" ? assets.get(request.url ?? "") : undefined;
		if (!asset) return response.writeHead(404).end();
		response
			.writeHead(200, {
				"content-type": asset.type,
				"content-security-policy":
					"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'",
			})
			.end(asset.body);
	});

	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.goto(origin);
		await page.getByRole("checkbox").check();
		await page.getByText("Collection enabled.", { exact: true }).waitFor();
		await page.getByRole("button", { name: "Search for account help" }).click();
		await page.getByRole("button", { name: "Reset your password" }).click();

		let records = store.pending(10);
		for (let i = 0; records.length < 4 && i < 100; i++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			records = store.pending(10);
		}
		assert.deepEqual(records.map(({ payload }) => payload.action_name).sort(), [
			"click",
			"result_impression",
			"results_shown",
			"search_submitted",
		]);
		assert.equal(
			new Set(records.map(({ payload }) => payload.query_id)).size,
			1,
		);
		assert.equal(
			new Set(records.map(({ payload }) => payload.session_id)).size,
			1,
		);
		assert.equal(
			new Set(
				records.flatMap(({ metadata }) =>
					metadata?.result_set ? [metadata.result_set] : [],
				),
			).size,
			1,
		);
		assert.ok(records.every(({ payload }) => !("user_query" in payload)));
	} finally {
		await browser.close();
	}
});
