import { createCollector, createHttpDelivery } from "../src/collector.ts";
import type { Profile } from "../src/profile.ts";
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

function showResults(queryId: string | undefined, hits: Target[]) {
	const items = hits.map((hit, index) => {
		const item = document.createElement("li");
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = hit.title;
		button.addEventListener("click", () => {
			if (queryId === undefined) return;
			void report(
				collector.trackEvent("click", {
					query_id: queryId,
					event_attributes: {
						position: { ordinal: index + 1 },
						object: { object_id: hit.id, object_id_type: "product" },
					},
					metadata: { result_set: queryId },
				}),
			);
		});
		item.append(button);
		return item;
	});
	results.replaceChildren(...items);
}

consent.addEventListener("change", () => {
	results.replaceChildren();
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
	showResults(queryId, hits);
	summary.textContent = `${hits.length} result(s)`;
	if (queryId !== undefined) {
		void report(collector.trackQuery({ query_id: queryId, user_query: term }));
	}
});
