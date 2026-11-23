import { createCollector, createHttpBatchDelivery } from "../src/collector.ts";
import { observeEngagement } from "../src/engagement.ts";
import { observeResultImpressions } from "../src/impressions.ts";
import type { Profile } from "../src/profile.ts";
import { createQueuedDelivery } from "../src/queued-delivery.ts";
import type { EventInput } from "../src/records.ts";
import {
	createSearchMeasurement,
	type DisplayedSearchResults,
} from "../src/search-measurement.ts";

type Target = { id: string; title: string };
const catalog: Record<string, Target[]> = {
	"garden tools": [
		{ id: "gloves", title: "Garden gloves" },
		{ id: "spade", title: "Garden spade" },
	],
	"no results": [],
};

const config = await fetch("/demo-config.json", {
	cache: "no-store",
	credentials: "omit",
});
if (!config.ok) throw new Error("could not load the demo profile");
const { profile, sha256 } = (await config.json()) as {
	profile: Profile;
	sha256: string;
};
const collector = createCollector({
	profile,
	profileHash: sha256,
	queue: createQueuedDelivery({
		profile,
		profileHash: sha256,
		sendBatch: createHttpBatchDelivery(profile.endpoint),
		parallelBatches: 2,
	}),
});

function element<T extends Element>(selector: string): T {
	const found = document.querySelector<T>(selector);
	if (!found) throw new Error(`missing demo element ${selector}`);
	return found;
}

const consent = element<HTMLInputElement>("#consent");
const form = element<HTMLFormElement>("#search");
const searchTerm = element<HTMLSelectElement>("#term");
const results = element<HTMLUListElement>("#results");
const status = element<HTMLParagraphElement>("#status");
const summary = element<HTMLParagraphElement>("#summary");
const detail = element<HTMLElement>("#detail");
const detailTitle = element<HTMLHeadingElement>("#detail-title");
const closeDetailButton = element<HTMLButtonElement>("#close-detail");
let engagement: ReturnType<typeof observeEngagement> | undefined;

function stopEngagement() {
	engagement?.close();
	engagement = undefined;
}

function closeDetail() {
	engagement?.checkpoint();
	stopEngagement();
	detail.hidden = true;
}

closeDetailButton.addEventListener("click", closeDetail);

async function report(operation: Promise<string>) {
	try {
		status.textContent = await operation;
	} catch {
		status.textContent = "Capture failed.";
	}
}

const searchMeasurement = createSearchMeasurement(collector);
let impressions: ReturnType<typeof observeResultImpressions> | undefined;

function resultEvent(
	display: DisplayedSearchResults,
	target: Target,
	ordinal: number,
): EventInput {
	return {
		query_id: display.queryId,
		event_attributes: {
			position: { ordinal },
			object: { object_id: target.id, object_id_type: "product" },
		},
		metadata: { result_set: display.resultSet },
	};
}

function openDetail(
	display: DisplayedSearchResults | undefined,
	target: Target,
	ordinal: number,
) {
	closeDetail();
	detailTitle.textContent = target.title;
	detail.hidden = false;
	closeDetailButton.focus();
	if (!display || display.signal.aborted) return;

	const detailId = crypto.randomUUID();
	const event = resultEvent(display, target, ordinal);
	const metadata = { ...event.metadata, detail_view_id: detailId };
	const firstClickMs = display.firstClickDelay();
	const { delivery, observation } = collector.trackEventWithObservation(
		"click",
		{
			...event,
			metadata:
				firstClickMs === undefined
					? metadata
					: { ...metadata, first_click_ms: firstClickMs },
		},
	);
	void report(delivery);
	if (!observation) return;

	engagement = observeEngagement({
		signal: observation.signal,
		onCheckpoint(engagedMs) {
			const checkpointAt = Date.now();
			void observation
				.sessionElapsedMs(checkpointAt)
				.then((elapsed) => {
					if (elapsed === undefined) return;
					return observation.trackEvent("result_dwell", {
						...event,
						metadata: {
							...metadata,
							engaged_ms: engagedMs,
							session_elapsed_ms: Math.floor(elapsed / 1000) * 1000,
						},
					});
				})
				.catch(() => {
					status.textContent = "Dwell capture failed.";
				});
		},
	});
}

function showResults(
	display: DisplayedSearchResults | undefined,
	hits: Target[],
) {
	impressions?.close();
	impressions =
		display && hits.length
			? observeResultImpressions(profile.impressions, (ordinal) => {
					const hit = hits[ordinal - 1];
					if (!hit || display.signal.aborted) return;

					void collector
						.trackEvent("result_impression", resultEvent(display, hit, ordinal))
						.catch(() => {
							status.textContent = "Impression capture failed.";
						});
				})
			: undefined;

	const items = hits.map((hit, index) => {
		const item = document.createElement("li");
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = hit.title;
		button.addEventListener("click", () => openDetail(display, hit, index + 1));
		item.append(button);
		return { item, button };
	});
	results.replaceChildren(...items.map(({ item }) => item));
	items.forEach(({ button }, index) => {
		impressions?.observe(button, index + 1);
	});
}

consent.addEventListener("change", () => {
	const granted = consent.checked;
	if (!granted) {
		impressions?.close();
		impressions = undefined;
		stopEngagement();
	}

	void report(
		collector
			.setConsent(granted)
			.then(() => (granted ? "Collection enabled." : "Collection disabled.")),
	);
});

form.addEventListener("submit", (event) => {
	event.preventDefault();
	closeDetail();

	const term = searchTerm.value;
	const hits = catalog[term] ?? [];
	const draw = (display?: DisplayedSearchResults) => {
		showResults(display, hits);
		summary.textContent = `${hits.length} result(s)`;
	};
	if (!consent.checked) {
		searchMeasurement.clear();
		draw();
		return;
	}

	const search = searchMeasurement.beginSearch(crypto.randomUUID());
	void report(search.submitted);
	const query = search.trackQueryText(term);
	if (query) void report(query);
	const rendered = search.render(
		{ resultCount: hits.length, rankingVersion: "sample-v1" },
		draw,
	);
	if (rendered) void report(rendered);
});
