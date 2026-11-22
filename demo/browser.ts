import { createCollector, createHttpDelivery } from "../src/collector.ts";
import { observeResultImpressions } from "../src/impressions.ts";
import type { Profile } from "../src/profile.ts";
import type { EventInput } from "../src/records.ts";
import { openSessionStore } from "../src/session-store.ts";

type Target = { id: string; title: string };
const catalog: Record<string, Target[]> = {
	"garden tools": [
		{ id: "gloves", title: "Garden gloves" },
		{ id: "spade", title: "Garden spade" },
	],
	"no results": [],
};

const config = await fetch("/demo-config.json", { cache: "no-store" });
if (!config.ok) throw new Error("could not load the demo profile");
const { profile, sha256 } = (await config.json()) as {
	profile: Profile;
	sha256: string;
};
const collector = createCollector({
	profile,
	profileHash: sha256,
	openStore: openSessionStore,
	async loadWasm() {
		const response = await fetch("/session.wasm");
		if (!response.ok) throw new Error("could not load the session module");
		return response.arrayBuffer();
	},
	deliver: createHttpDelivery(profile.endpoint),
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

async function report(operation: Promise<string>) {
	try {
		status.textContent = await operation;
	} catch {
		status.textContent = "Capture failed.";
	}
}

type Display = { queryId: string; resultSet: string };
let impressions: ReturnType<typeof observeResultImpressions> | undefined;

function resultEvent(
	display: Display,
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

function showResults(display: Display | undefined, hits: Target[]) {
	impressions?.close();
	impressions =
		display && hits.length
			? observeResultImpressions(profile.impressions, (ordinal) => {
					const hit = hits[ordinal - 1];
					if (!hit) return;

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
		button.addEventListener("click", () => {
			if (display)
				void report(
					collector.trackEvent("click", resultEvent(display, hit, index + 1)),
				);
		});
		item.append(button);
		return { item, button };
	});
	results.replaceChildren(...items.map(({ item }) => item));
	items.forEach(({ button }, index) => {
		impressions?.observe(button, index + 1);
	});
}

consent.addEventListener("change", () => {
	showResults(undefined, []);
	summary.textContent = "";
	void report(
		collector
			.setConsent(consent.checked)
			.then(() =>
				consent.checked ? "Collection enabled." : "Collection disabled.",
			),
	);
});

form.addEventListener("submit", (event) => {
	event.preventDefault();

	const queryId = consent.checked ? crypto.randomUUID() : undefined;
	const term = searchTerm.value;
	const hits = catalog[term] ?? [];
	showResults(
		queryId === undefined
			? undefined
			: { queryId, resultSet: crypto.randomUUID() },
		hits,
	);
	summary.textContent = `${hits.length} result(s)`;
	if (queryId !== undefined) {
		void report(collector.trackQuery({ query_id: queryId, user_query: term }));
	}
});
