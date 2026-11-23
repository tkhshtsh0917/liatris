import {
	createCollector,
	createHttpBatchDelivery,
} from "/assets/liatris/collector.js";
import { observeResultImpressions } from "/assets/liatris/impressions.js";
import { createQueuedDelivery } from "/assets/liatris/queued-delivery.js";
import { createSearchMeasurement } from "/assets/liatris/search-measurement.js";

/** @param {string} name */
async function asset(name) {
	const response = await fetch(`/assets/liatris/${name}`, {
		credentials: "omit",
	});
	if (!response.ok) throw new Error(`Could not load ${name}`);
	return response;
}

const [profile, hash] = await Promise.all([
	asset("profile.json").then((response) => response.json()),
	asset("profile.sha256").then((response) => response.text()),
]);
const profileHash = hash.trim();
const collector = createCollector({
	profile,
	profileHash,
	queue: createQueuedDelivery({
		profile,
		profileHash,
		sendBatch: createHttpBatchDelivery(profile.endpoint),
	}),
	loadWasm: async () => (await asset("session.wasm")).arrayBuffer(),
});
const search = createSearchMeasurement(collector);
const consent = document.querySelector("#consent");
const button = document.querySelector("#search");
const results = document.querySelector("#results");
const status = document.querySelector("#status");
if (
	!(consent instanceof HTMLInputElement) ||
	!(button instanceof HTMLButtonElement) ||
	!results ||
	!status
)
	throw new Error("Missing example controls");

let stopImpressions = () => {};
const captureFailed = () => {
	status.textContent = "Capture failed.";
};

consent.addEventListener("change", async () => {
	button.disabled = true;
	search.clear();
	stopImpressions();
	results.replaceChildren();
	try {
		const granted = consent.checked;
		await collector.setConsent(granted);
		status.textContent = granted
			? "Collection enabled."
			: "Collection disabled.";
	} catch {
		captureFailed();
	} finally {
		button.disabled = false;
	}
});
button.disabled = false;
button.addEventListener("click", () => {
	const request = search.beginSearch(crypto.randomUUID());
	void request.submitted.catch(captureFailed);

	const rendered = request.render(
		{ resultCount: 1, rankingVersion: "help-v1" },
		(display) => {
			stopImpressions();
			const item = document.createElement("li");
			const result = document.createElement("button");
			result.type = "button";
			result.textContent = "Reset your password";
			item.append(result);
			results.replaceChildren(item);
			if (!display) return;

			const input = {
				query_id: display.queryId,
				event_attributes: {
					position: { ordinal: 1 },
					object: { object_id: "reset-password" },
				},
				metadata: { result_set: display.resultSet },
			};
			const observer = observeResultImpressions(profile.impressions, () => {
				void collector
					.trackEvent("result_impression", input)
					.catch(captureFailed);
			});
			observer.observe(result, 1);
			stopImpressions = () => observer.close();
			result.addEventListener("click", () => {
				void collector.trackEvent("click", input).catch(captureFailed);
			});
		},
	);
	void rendered?.catch(captureFailed);
});
