import type { Page, Request } from "playwright";
import type { Envelope } from "../../src/records.ts";

export function postedEvents(request: Request): Envelope[] {
	if (!request.url().endsWith("/api/ubi") || request.method() !== "POST")
		return [];
	return request.postDataJSON() as Envelope[];
}

export function submission(request: Request) {
	return postedEvents(request).find(
		({ payload }) => payload.action_name === "search_submitted",
	);
}

export async function openSearch(page: Page, origin: string) {
	await page.goto(origin);
	await page.getByRole("checkbox").check();
	await page.getByText("Collection enabled.", { exact: true }).waitFor();
	return page.getByRole("button", { name: "Search", exact: true });
}
