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
		parallelBatches: 2,
	}),
});
const search = createSearchMeasurement(collector);
const consent = document.querySelector("#consent");
const consentStatus = document.querySelector("#consent-status");
const button = document.querySelector("#search");
const results = document.querySelector("#results");
const status = document.querySelector("#status");
if (
	!(consent instanceof HTMLInputElement) ||
	!consentStatus ||
	!(button instanceof HTMLButtonElement) ||
	!results ||
	!status
)
	throw new Error("Missing example controls");

let stopImpressions = () => {};
const captureFailed = () => {
	status.textContent = "Capture failed.";
};

/** @param {string} [message] */
const showConsent = (message) => {
	consent.checked = collector.consentSignal !== undefined;
	consentStatus.textContent =
		message ??
		(consent.checked ? "Collection enabled." : "Collection disabled.");
};

consent.addEventListener("change", async () => {
	consent.disabled = true;
	try {
		await collector.setConsent(consent.checked);
		collector.consentSignal?.addEventListener(
			"abort",
			() => {
				stopImpressions();
				if (!consent.disabled) showConsent();
			},
			{ once: true },
		);
		showConsent();
	} catch {
		showConsent("Could not update collection consent.");
	} finally {
		consent.disabled = false;
	}
});
consent.disabled = false;
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
				if (display.signal.aborted) return;
				void collector
					.trackEvent("result_impression", input)
					.catch(captureFailed);
			});
			observer.observe(result, 1);
			stopImpressions = () => observer.close();
			result.addEventListener("click", () => {
				if (display.signal.aborted) return;
				void collector.trackEvent("click", input).catch(captureFailed);
			});
		},
	);
	void rendered?.catch(captureFailed);
});
