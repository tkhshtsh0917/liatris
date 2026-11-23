# Event contracts and funnels

[日本語](ja/event-contracts.md)

## Selecting events

An integration declares event names and allowed fields in its collection profile. The application owns the trigger. The analysis pipeline defines funnels, including deadlines, ordering, and attribution. One set of recorded events can serve several funnel definitions.

| Event | Capture point |
| --- | --- |
| Search query | The user submits a search. A search retry retains its query ID. A fresh search gets a new ID. |
| Results shown | The application renders a result set, including an empty result set. |
| Result impression | A registered card reaches the configured visible area in the foreground. Deduplicate by result set and displayed position. |
| Result click | The user acts on a visible result. Supply the query ID, object ID and observed rank. |
| Detail view | The detail page or route is rendered. |
| Add to cart or save job | The action succeeds in the application. |
| Purchase or submit application | The service confirms the business outcome. Prefer a server-side event for confirmation. |

An example commerce funnel is query → results → detail → add to cart → purchase. A jobs funnel can use query → results → detail → save → apply. A session ID groups activity within a visit. Preserve explicit search context for attribution across views and choose a conversion window independently of the session timeout.

## Card impressions

The browser helper measures geometric viewport intersection for cards registered by the host. Once at least 50% of the card's area is visible in the foreground tab, the demo records `result_impression` with its query ID, displayed result-set ID, and 1-based rank. Exactly one trigger per rank is eligible for each registered result set. A replaced or reordered result set needs its own observer. Unregister recycled elements and close the observer on navigation or consent revocation.

The collection profile accepts `impressions.minVisiblePercent` as an integer from 1 to 100 in TOML, YAML, or JSON. The default follows the [Google Tag Manager Element Visibility trigger](https://support.google.com/tagmanager/answer/7679410?hl=en). The collector does not require a minimum duration or measure occlusion by an overlay or the user's attention. See the [Intersection Observer specification](https://www.w3.org/TR/intersection-observer/).

The GA4-inspired session is independently configurable through `session.inactivityMinutes`. The range is 1–1440 whole minutes, with a default of 30. [GA4 sessions](https://support.google.com/analytics/answer/9191807?hl=en).

## Declaring event-specific fields

```toml
[events.job_saved.fields.job_id]
type = "string"
required = true
maxLength = 100
```

The application calls `trackEvent("job_saved", { metadata: { job_id } })` after its save succeeds. Use `metadata` for event-specific fields. When an event has a measured position, it can include `event_attributes` and the UBI extensions declared for those paths. The collector accepts a 1-based ordinal at this stage. Supply `query_id` when a known search led to the action.

Test delayed responses, rate-limited or retried actions, repeated rendering, virtualized lists and cross-tab behavior at the integration points. A durable delivery ID and a business ID, such as an order ID, serve separate deduplication purposes.

## Measuring a search surface

Create a search measurement with `createSearchMeasurement(collector)` for each result surface. For each deliberate search, keep the returned request with `const request = search.beginSearch(queryId)`. The helper sends `search_submitted` with the opaque query ID. The optional `request.trackQueryText` sends a separate UBI Query when the profile permits it.

Declare `search_submitted` and `results_shown` in the profile. Use `minimum: 0` on the integer fields for displayed count and click delay. Call `request.render({ resultCount, rankingVersion, metadata }, draw)` when a response is ready to display. The helper accepts the current request for that surface, passes the result-set ID to the synchronous UI callback, and sends `results_shown` after the callback succeeds. A discarded stale response leaves the UI and measurement untouched. Call `clear()` when the surface is left or reset. For a framework with asynchronous commits, run the measurement from the point where the new results have committed.

Use the returned display context in impression and click events. Call `firstClickDelay()` on the first actual result click and attach its value as `first_click_ms` if available. A later click on the same set omits this field. Every committed replacement set has its own measurement and ID. The initial search and its rendered response use the same search session even if the response arrives after the inactivity boundary.

Count submitted searches by distinct query ID, and shown sets by distinct query and result-set ID. A shown set with `result_count = 0` is an observed zero-result set. A submitted search with no recorded render has an unknown result count. Calculate impression-based CTR from observed result-slot exposures, joined by query, result set, item and displayed rank. A click without a matching exposure is a separate coverage case.

## Recording an experiment variant

The host chooses the assignment unit and variant using its own experimentation system. Declare the fields on the relevant event in the collection profile. Use `metadata` to pass the assignment already applied by the host. The sample profile accepts optional `experiment_id` and `variant` on `results_shown`. Attach them to the rendered set so later clicks can join by `query_id` and `result_set`.

For example, pass `metadata: { experiment_id: "search-ranking", variant: "treatment" }` to `request.render` after the host selects the ranking treatment. On other events, pass declared fields through `trackEvent`. Use experiment and variant labels and keep user or account identifiers out of these fields. The helper generates the result-set ID, result count and ranking version from the render arguments. Custom metadata cannot replace them.

## Duration and search metrics

The collector provides opt-in engagement timing. The demo records whole-second deltas as `result_dwell` and supplies the original click session, query, result set, ordinal, item and detail-view ID. The search measurement helper records submitted searches, completed renders and the delay to the first click.

| Metric | Observation and aggregation |
| --- | --- |
| Session elapsed time | Time from the assigned session start to the event. A fresh session starts at zero. This is a wall-clock duration for funnel analysis and can include idle periods. The demo uses `session_elapsed_ms` at dwell checkpoints. |
| Engaged time on a detail view | Sum eligible intervals for one rendered detail view. Start after consent when the view is visible and focused. End the interval at blur, hidden state, route exit, consent withdrawal or the configured inactivity cutoff, whichever comes first. |
| Search-result dwell | Attribute engaged time on an instrumented destination to the originating result click. Keep click-to-return elapsed time as a separate metric. Treat an unobserved destination or missing return as unknown. |
| Time to first click | From rendering a particular result set until its first click. Use a render-based denominator and report the no-click count with its observation window. |
| Search outcomes | Measure zero-result rate per rendered set, impression-based CTR by displayed rank, reformulations per search journey and downstream conversion within a declared attribution window. Record denominators and observation coverage. |

Use `observeEngagement` for one rendered detail view and pass `observation.signal` from the originating click's `trackEventWithObservation` result when an observation is available. The helper default inactivity cutoff is 60 seconds and can be set with `idleMs`. Close the observer on navigation, and checkpoint first when the view exits with consent. Use a monotonic clock for intervals within one document. Accrue only up to the last qualifying activity plus the inactivity window, even if a background timer runs hours late. The cutoff limits the estimate during unattended focus and can undercount quiet reading. A qualifying input renews the remaining idle budget. Route changes start a fresh measurement. Visibility and back-forward restoration resume measurement within the remaining budget. Keep page-view, click and result-set IDs distinct across tabs. Do not sum overlapping tab intervals to estimate time per person.

Attach coarse duration deltas to eligible checkpoints. Exclude timing checkpoints from session renewal. Discard unsent intervals on withdrawal. Keep input contents, key values and pointer paths out of timing records. Test suspension, hidden tabs, three-hour absences, session expiry, missing exits and retries before enabling the metrics. [GA4 engagement](https://support.google.com/analytics/answer/11109416) · [Client and server dwell-time study](https://www.microsoft.com/en-us/research/publication/comparing-client-server-dwell-time-estimates-click-level-satisfaction-prediction/) · [Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)
