import {
	ConsentWithdrawalError,
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
const retryWithdrawal = document.querySelector("#retry-withdrawal");
const button = document.querySelector("#search");
const results = document.querySelector("#results");
const status = document.querySelector("#status");
if (
	!(consent instanceof HTMLInputElement) ||
	!consentStatus ||
	!(retryWithdrawal instanceof HTMLButtonElement) ||
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

let updatingConsent = false;
const retryKey = JSON.stringify([
	"liatris-example-withdrawal",
	profile.tenant,
	profile.application,
]);
/** @type {import("/assets/liatris/collector.js").WithdrawalRetry | undefined} */
let savedWithdrawal;
try {
	const stored = sessionStorage.getItem(retryKey);
	if (stored) savedWithdrawal = JSON.parse(stored);
} catch {
	// In-page retries also work when sessionStorage is unavailable.
}

/** @param {import("/assets/liatris/collector.js").WithdrawalRetry} [retry] */
function rememberWithdrawal(retry) {
	savedWithdrawal = retry;
	try {
		if (retry) sessionStorage.setItem(retryKey, JSON.stringify(retry));
		else sessionStorage.removeItem(retryKey);
	} catch {
		// Retain the in-page retry target.
	}
}

/** Applies an explicit choice and keeps failed withdrawals available for retry.
 * @param {boolean} granted
 */
const updateConsent = async (granted) => {
	updatingConsent = true;
	consent.setAttribute("aria-disabled", "true");
	retryWithdrawal.setAttribute("aria-disabled", "true");

	try {
		if (!granted && savedWithdrawal)
			await collector.retryConsentWithdrawal(savedWithdrawal);
		else await collector.setConsent(granted);

		if (!granted) rememberWithdrawal();
		collector.consentSignal?.addEventListener(
			"abort",
			() => {
				stopImpressions();
				if (!updatingConsent) showConsent();
			},
			{ once: true },
		);
		if (document.activeElement === retryWithdrawal) consent.focus();
		retryWithdrawal.hidden = true;
		showConsent();
	} catch (error) {
		if (error instanceof ConsentWithdrawalError && error.retry)
			rememberWithdrawal(error.retry);
		retryWithdrawal.hidden = granted;
		showConsent(
			granted
				? "Could not enable collection."
				: "Could not complete withdrawal.",
		);
	} finally {
		updatingConsent = false;
		retryWithdrawal.removeAttribute("aria-disabled");
		if (retryWithdrawal.hidden) consent.removeAttribute("aria-disabled");
	}
};

consent.addEventListener("click", (event) => {
	if (updatingConsent || !retryWithdrawal.hidden) event.preventDefault();
});
consent.addEventListener("change", () => {
	void updateConsent(consent.checked);
});
retryWithdrawal.addEventListener("click", () => {
	if (!updatingConsent) void updateConsent(false);
});
consent.disabled = false;
if (savedWithdrawal) void updateConsent(false);
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
