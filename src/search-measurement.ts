import type { createCollector } from "./collector.ts";
import { readString } from "./fields.ts";

type Collector = Pick<
	ReturnType<typeof createCollector>,
	"trackEventWithObservation"
>;
type RenderedResults = { resultCount: number; rankingVersion: string };

export type DisplayedSearchResults = {
	readonly queryId: string;
	readonly resultSet: string;
	/** Returns the elapsed milliseconds for the first click on this displayed set. */
	firstClickDelay(): number | undefined;
};

/** Measures search lifecycle events for one independently rendered result surface. */
export function createSearchMeasurement(collector: Collector) {
	let latest: symbol | undefined;

	return {
		/** Clears the current measurement when leaving the surface or changing consent. */
		clear() {
			latest = undefined;
		},

		/** Records an explicit search without collecting its text. */
		beginSearch(queryId: string) {
			readString(queryId, 100);
			const request = Symbol();
			latest = request;
			const { delivery: submitted, observation } =
				collector.trackEventWithObservation("search_submitted", {
					query_id: queryId,
				});

			return {
				submitted,
				/** Optionally appends a UBI Query record when the profile allows search text. */
				trackQueryText(query: string) {
					return observation?.trackQuery({
						query_id: queryId,
						user_query: query,
					});
				},

				/** Commits a current response and emits a snapshot after the UI update. */
				render(
					{ resultCount, rankingVersion }: RenderedResults,
					draw: (display: DisplayedSearchResults | undefined) => void,
				) {
					if (latest !== request) return;
					if (!Number.isSafeInteger(resultCount) || resultCount < 0) {
						throw new RangeError(
							"displayed result count must be a non-negative safe integer",
						);
					}
					readString(rankingVersion, 100);
					if (!observation || observation.signal.aborted) {
						draw(undefined);
						return;
					}

					const resultSet = crypto.randomUUID();
					let renderedAt: number | undefined;
					draw({
						queryId,
						resultSet,
						firstClickDelay() {
							if (renderedAt === undefined || observation.signal.aborted)
								return;
							const elapsed = Math.max(
								0,
								Math.floor(performance.now() - renderedAt),
							);
							renderedAt = undefined;
							return elapsed;
						},
					});
					renderedAt = performance.now();

					return observation.trackEvent("results_shown", {
						query_id: queryId,
						metadata: {
							result_set: resultSet,
							result_count: resultCount,
							ranking_version: rankingVersion,
						},
					});
				},
			};
		},
	};
}
