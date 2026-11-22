# Event contracts and funnels

[日本語](ja/event-contracts.md)

## Selecting events

An integration declares event names and allowed fields in its collection profile. The application owns the trigger. The analysis pipeline defines funnels, including deadlines, ordering, and attribution. One set of recorded events can serve several funnel definitions.

| Event | Capture point |
| --- | --- |
| Search query | The user submits a search. A search retry retains its query ID. A fresh search gets a new ID. |
| Results shown | The application renders a result set, including an empty result set. |
| Result impression | A visible card crosses the application-defined exposure threshold. Deduplicate by result set and displayed position. |
| Result click | The user acts on a visible result. Supply the query ID, object ID and observed rank. |
| Detail view | The detail page or route is rendered. |
| Add to cart or save job | The action succeeds in the application. |
| Purchase or submit application | The service confirms the business outcome. Prefer a server-side event for confirmation. |

An example commerce funnel is query → results → detail → add to cart → purchase. A jobs funnel can use query → results → detail → save → apply. A session ID groups activity within a visit. Preserve explicit search context for attribution across views and choose a conversion window independently of the session timeout.

## Declaring event-specific fields

```toml
[events.job_saved.fields.job_id]
type = "string"
required = true
maxLength = 100
```

The application calls `trackEvent("job_saved", { metadata: { job_id } })` after its save succeeds. Use `metadata` for event-specific fields. When an event has a measured position, it can include `event_attributes` and the UBI extensions declared for those paths. The collector accepts a 1-based ordinal at this stage. Supply `query_id` when a known search led to the action.

Test delayed responses, rate-limited or retried actions, repeated rendering, virtualized lists and cross-tab behavior at the integration points. A durable delivery ID and a business ID, such as an order ID, serve separate deduplication purposes.
