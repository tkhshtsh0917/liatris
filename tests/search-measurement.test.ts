import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateRecord } from "../server/validate.ts";
import { createCollector, type Delivery } from "../src/collector.ts";
import type { Envelope } from "../src/records.ts";
import {
	createSearchMeasurement,
	type DisplayedSearchResults,
} from "../src/search-measurement.ts";
import { memorySessionStore } from "../src/session-store.ts";
import { compileProfile } from "../tools/profile.ts";

const { profile, sha256 } = compileProfile(
	await readFile(new URL("../examples/shop.toml", import.meta.url), "utf8"),
	"toml",
);
const settings = { resultCount: 0, rankingVersion: "ranker-v1" };

function setup(allowQueryText = true, deliver?: Delivery) {
	const sent: Envelope[] = [];
	const settings = { ...profile, allowQueryText };
	const collector = createCollector({
		profile: settings,
		profileHash: sha256,
		openStore: async () => memorySessionStore(),
		deliver:
			deliver ??
			(async (record) => {
				sent.push(validateRecord(record, settings, sha256));
			}),
	});
	return { collector, sent, meter: createSearchMeasurement(collector) };
}

test("records submitted searches without text and distinguishes an empty render from a late response", async () => {
	const { collector, sent, meter } = setup(false);
	await collector.setConsent(true);
	const earlier = meter.beginSearch("previous");
	const current = meter.beginSearch("latest");
	await Promise.all([earlier.submitted, current.submitted]);

	assert.equal(
		earlier.render(settings, () => assert.fail("stale render")),
		undefined,
	);
	assert.equal(
		await current.trackQueryText("private text"),
		"query-text-disabled",
	);
	assert.equal(
		await current.render(settings, (display) => {
			assert.equal(display?.queryId, "latest");
			assert.equal(sent.length, 2);
		}),
		"sent",
	);
	assert.equal(sent.length, 3);
	assert.equal(sent[2].payload.action_name, "results_shown");
	assert.equal(sent[2].payload.query_id, "latest");
	assert.equal(sent[2].metadata?.result_count, 0);
	assert.equal(sent[2].metadata?.ranking_version, "ranker-v1");
	assert.throws(
		() =>
			validateRecord(
				{
					...sent[2],
					metadata: { ...sent[2].metadata, result_count: -1 },
				},
				profile,
				sha256,
			),
		/invalid custom field/,
	);
	assert.ok(
		sent.every((record) => !Object.hasOwn(record.payload, "user_query")),
	);
});

test("pins the original session and times only the first click for each rendered result set", async (t) => {
	let mono = 0;
	let wall = Date.parse("2026-11-22T00:00:00.000Z");
	t.mock.method(performance, "now", () => mono);
	t.mock.method(Date, "now", () => wall);
	const { collector, sent, meter } = setup();
	await collector.setConsent(true);

	const search = meter.beginSearch("delayed");
	await search.submitted;
	assert.equal(await search.trackQueryText("synthetic query"), "sent");
	wall += 30 * 60_000;
	await collector.trackEvent("add_cart");

	let first: DisplayedSearchResults | undefined;
	await search.render({ ...settings, resultCount: 2 }, (display) => {
		first = display;
		mono = 75;
	});
	assert.ok(first);
	mono = 200;
	assert.equal(first.firstClickDelay(), 125);
	assert.equal(first.firstClickDelay(), undefined);

	let second: DisplayedSearchResults | undefined;
	await search.render({ ...settings, resultCount: 1 }, (display) => {
		second = display;
	});
	assert.ok(second);
	assert.notEqual(first.resultSet, second.resultSet);
	mono = 220;
	assert.equal(second.firstClickDelay(), 20);
	assert.equal(sent[3].payload.session_id, sent[0].payload.session_id);
	assert.equal(sent[4].payload.session_id, sent[0].payload.session_id);
	assert.notEqual(sent[2].payload.session_id, sent[0].payload.session_id);
});

test("keeps rendering available without consent and cancels tracking after revocation", async () => {
	const { collector, sent, meter } = setup();
	const anonymous = meter.beginSearch("guest");
	assert.equal(await anonymous.submitted, "no-consent");
	anonymous.render(settings, (display) => assert.equal(display, undefined));

	await collector.setConsent(true);
	const search = meter.beginSearch("allowed");
	await search.submitted;
	await assert.rejects(
		async () =>
			search.render({ ...settings, resultCount: -1 }, () => assert.fail()),
		/non-negative/,
	);
	assert.throws(
		() =>
			search.render(settings, () => {
				throw new Error("render failed");
			}),
		/render failed/,
	);
	await collector.setConsent(false);
	await collector.setConsent(true);
	const drawn: (DisplayedSearchResults | undefined)[] = [];
	assert.equal(
		search.render(settings, (display) => drawn.push(display)),
		undefined,
	);
	assert.deepEqual(drawn, [undefined]);

	meter.clear();
	assert.equal(
		search.render(settings, () => assert.fail("closed surface rendered")),
		undefined,
	);
	assert.equal(sent.length, 1);
});

test("aborts an existing display signal permanently when consent is withdrawn", async () => {
	const { collector, meter } = setup();
	await collector.setConsent(true);
	const earlier = meter.beginSearch("before-withdrawal");
	await earlier.submitted;

	let previous: DisplayedSearchResults | undefined;
	await earlier.render(settings, (display) => {
		previous = display;
	});
	assert.ok(previous);
	assert.equal(previous.signal.aborted, false);

	await collector.setConsent(false);
	assert.equal(previous.signal.aborted, true);
	await collector.setConsent(true);
	assert.equal(previous.signal.aborted, true);
	assert.equal(previous.firstClickDelay(), undefined);

	const current = meter.beginSearch("after-regrant");
	await current.submitted;
	assert.equal(
		await current.render(settings, (display) => {
			assert.ok(display);
			assert.equal(display.signal.aborted, false);
			assert.notEqual(display.resultSet, previous?.resultSet);
		}),
		"sent",
	);
});

test("records a rendered response while the submitted event awaits delivery", async () => {
	const delivered = Promise.withResolvers<void>();
	const sent: Envelope[] = [];
	const { collector, meter } = setup(true, async (record) => {
		sent.push(record);
		if (record.payload.action_name === "search_submitted")
			await delivered.promise;
	});
	await collector.setConsent(true);
	const search = meter.beginSearch("pending");
	try {
		assert.equal(await search.render(settings, () => {}), "sent");
		assert.equal(sent.length, 2);
		assert.equal(sent[1].payload.session_id, sent[0].payload.session_id);
	} finally {
		delivered.resolve();
	}
	await search.submitted;
});

test("captures host-supplied variant metadata without altering generated fields", async () => {
	const { collector, sent, meter } = setup();
	await collector.setConsent(true);
	const search = meter.beginSearch("assigned-by-site");
	await search.submitted;

	assert.throws(
		() =>
			search.render({ ...settings, metadata: { result_count: 9 } }, () =>
				assert.fail("render used conflicting metadata"),
			),
		/generated field/,
	);
	const undeclared = search.render(
		{ ...settings, metadata: { undeclared: true } },
		() => {},
	);
	assert.ok(undeclared);
	await assert.rejects(undeclared, /undeclared field/);

	const metadata = { experiment_id: "search-ranking", variant: "treatment" };
	const rendered = search.render({ ...settings, metadata }, () => {
		metadata.variant = "control";
	});
	assert.equal(await rendered, "sent");
	assert.equal(sent.length, 2);
	assert.deepEqual(sent[1].metadata, {
		experiment_id: "search-ranking",
		variant: "treatment",
		result_set: sent[1].metadata?.result_set,
		result_count: 0,
		ranking_version: "ranker-v1",
	});
});
