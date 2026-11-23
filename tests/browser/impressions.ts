import assert from "node:assert/strict";
import test from "node:test";
import { chromium, devices, webkit } from "playwright";
import type { Envelope } from "../../src/records.ts";

export function registerImpressionTests(origin: string) {
	for (const [engine, device] of [
		[chromium, "Pixel 7"],
		[webkit, "iPhone 13"],
	] as const) {
		test(`${device} measures the visible fraction and records consented impressions`, {
			timeout: 30_000,
		}, async () => {
			const browser = await engine.launch();
			try {
				const context = await browser.newContext(devices[device]);
				const page = await context.newPage();
				await page.goto(origin);
				const search = page.getByRole("button", {
					name: "Search",
					exact: true,
				});
				const impressionIds = new Set<string>();
				let postCount = 0;
				const twoImpressions = Promise.withResolvers<void>();
				page.on("response", async (response) => {
					if (
						!response.url().endsWith("/api/ubi") ||
						response.request().method() !== "POST"
					)
						return;
					postCount++;
					const events = response.request().postDataJSON() as Envelope[];
					const receipts = (await response.json()) as {
						event_id: string;
						status: string;
					}[];
					for (const event of events) {
						if (
							event.payload.action_name === "result_impression" &&
							receipts.some(
								({ event_id, status }) =>
									event_id === event.event_id && status === "accepted",
							)
						)
							impressionIds.add(event.event_id);
					}
					if (impressionIds.size === 2) twoImpressions.resolve();
				});

				await search.tap();
				await page.getByText("2 result(s)", { exact: true }).waitFor();
				assert.equal(postCount, 0);
				await page.getByRole("checkbox").check();
				await page.getByText("Collection enabled.", { exact: true }).waitFor();
				await search.tap();
				await twoImpressions.promise;

				const seen = await page.evaluate(async () => {
					const { observeResultImpressions } = (await import(
						"/assets/src/impressions.js" as string
					)) as typeof import("../../src/impressions.ts");
					const card = document.createElement("div");
					Object.assign(card.style, {
						position: "fixed",
						left: "0",
						width: "100px",
						height: "100px",
					});
					const normal: number[] = [];
					const custom: number[] = [];
					const standard = observeResultImpressions({}, (rank) =>
						normal.push(rank),
					);
					const override = observeResultImpressions(
						{ minVisiblePercent: 70 },
						(rank) => custom.push(rank),
					);
					document.body.append(card);
					card.style.top = "-60px";
					standard.observe(card, 1);
					override.observe(card, 1);

					async function measure(top: number) {
						card.style.top = `${top}px`;
						const ratio = await new Promise<number>((resolve) => {
							const probe = new IntersectionObserver(([entry]) => {
								probe.disconnect();
								resolve(entry.intersectionRatio);
							});
							probe.observe(card);
						});
						await new Promise<void>((resolve) =>
							requestAnimationFrame(() => resolve()),
						);
						return {
							ratio: Math.round(ratio * 100),
							normal: normal.length,
							custom: custom.length,
						};
					}

					const samples = [
						await measure(-60),
						await measure(-50),
						await measure(-30),
						await measure(0),
					];
					standard.close();
					override.close();
					card.remove();
					return samples;
				});
				assert.deepEqual(seen, [
					{ ratio: 40, normal: 0, custom: 0 },
					{ ratio: 50, normal: 1, custom: 0 },
					{ ratio: 70, normal: 1, custom: 1 },
					{ ratio: 100, normal: 1, custom: 1 },
				]);
			} finally {
				await browser.close();
			}
		});
	}
}
