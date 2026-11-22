import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { KinesisClient, PutRecordsCommand } from "@aws-sdk/client-kinesis";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { openEventStore } from "../server/event-store.ts";
import { forwardToKinesis } from "../server/kinesis.ts";
import { compileProfile } from "./profile.ts";

const stream = process.env.LIATRIS_KINESIS_STREAM;
if (!stream)
	throw new Error("configure LIATRIS_KINESIS_STREAM for the forwarding worker");

const profileFile =
	process.env.LIATRIS_PROFILE ??
	new URL("../examples/shop.toml", import.meta.url);
const { profile } = compileProfile(await readFile(profileFile, "utf8"), "toml");
const store = openEventStore(
	process.env.LIATRIS_DB ?? "liatris-demo.sqlite",
	profile,
);
const endpoint = process.env.AWS_ENDPOINT_URL_KINESIS;
const client = new KinesisClient({
	maxAttempts: 1,
	...(endpoint?.startsWith("http:")
		? { requestHandler: new NodeHttpHandler() }
		: {}),
});
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());

let retryMs = 1_000;
try {
	while (!stop.signal.aborted) {
		let failed = false;
		let forwarded = 0;
		try {
			const signal = AbortSignal.any([
				stop.signal,
				AbortSignal.timeout(15_000),
			]);
			const result = await forwardToKinesis(
				store,
				stream,
				(input, abortSignal) =>
					client.send(new PutRecordsCommand(input), { abortSignal }),
				signal,
			);
			failed = result.failed > 0;
			forwarded = result.sent;
		} catch {
			if (stop.signal.aborted) break;
			failed = true;
		}

		if (failed) {
			console.warn("Kinesis delivery will retry");
			await sleep(retryMs, undefined, { signal: stop.signal });
			retryMs = Math.min(30_000, retryMs * 2);
		} else {
			retryMs = 1_000;
			if (!forwarded) await sleep(1_000, undefined, { signal: stop.signal });
		}
	}
} catch (error) {
	if (!stop.signal.aborted) throw error;
} finally {
	client.destroy();
	store.close();
}
