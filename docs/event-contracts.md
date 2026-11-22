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

## Proposed duration and search metrics

The following M2 measurements are opt-in design targets. The current collector records event timestamps and session IDs.

| Metric | Observation and aggregation |
| --- | --- |
| Session elapsed time | Time from the assigned session start to the event. A fresh session starts at zero. This is a wall-clock duration for funnel analysis and can include idle periods. |
| Engaged time on a detail view | Sum eligible intervals for one rendered detail view. Start after consent when the view is visible and focused. End the interval at blur, hidden state, route exit, consent withdrawal or the configured inactivity cutoff, whichever comes first. |
| Search-result dwell | Attribute engaged time on an instrumented destination to the originating result click. Keep click-to-return elapsed time as a separate metric. Treat an unobserved destination or missing return as unknown. |
| Time to first click | From rendering a particular result set until its first click. Report no-click views and the observation window separately. |
| Search outcomes | Measure zero-result rate per rendered set, impression-based CTR by displayed rank, reformulations per search journey and downstream conversion within a declared attribution window. Record denominators and observation coverage. |

Use a monotonic clock for intervals within one document. Accrue only up to the last qualifying activity plus the inactivity window, even if a background timer runs hours late. The cutoff limits the estimate during unattended focus and can undercount quiet reading. Resume with a fresh interval after activity, route changes or restoration from the back-forward cache. Keep page-view, click and result-set IDs distinct across tabs. Do not sum overlapping tab intervals to estimate time per person.

Attach coarse duration deltas to eligible checkpoints. Exclude timing checkpoints from session renewal. Discard unsent intervals on withdrawal. Keep input contents, key values and pointer paths out of timing records. Test suspension, hidden tabs, three-hour absences, session expiry, missing exits and retries before enabling the metrics. [GA4 engagement](https://support.google.com/analytics/answer/11109416) · [Client and server dwell-time study](https://www.microsoft.com/en-us/research/publication/comparing-client-server-dwell-time-estimates-click-level-satisfaction-prediction/) · [Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)
