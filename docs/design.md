# Liatris design

[日本語](ja/design.md) · [Roadmap](roadmap.md) · [Security and privacy](security.md)

## Collection and event contracts

A TypeScript host handles application calls, the browser clock, Web Crypto, IndexedDB, and delivery. Rust/WASM decides when the session expires. Integrations add events through profile declarations and the TypeScript collector API. The application declares event names and fields in JSON, YAML, or TOML and calls `trackQuery` and `trackEvent` at domain-specific points. The compiler produces equivalent normalized JSON and a SHA-256 profile identifier for the browser and receiver. A site must explicitly enable query text capture.

The host supplies the query ID that belongs to the displayed result, the result ID and its 1-based visible rank. A Search API that already emits the Query record can provide its ID for browser-side clicks. Event-specific custom fields are validated in envelope metadata. Supported UBI extension paths are validated against the profile and embedded in the UBI payload. Position is required when supplying `event_attributes`.

## UBI and sessions

The receiver verifies the collection contract and the selected [UBI v1.3.0 schema](../schema/upstream/ubi-1.3.0/README.md). Strict validation is the default. The compatibility option addresses overlapping schema branches for known action names and object types. The sample uses compatibility mode to submit a `click` on a `product`.

The default session timeout is 30 minutes of inactivity. Same-origin tabs can share session state through one IndexedDB transaction per activity. Consent starts disabled in each collector. Revocation stops collection, aborts pending delivery and deletes the persisted session for the configured application. Queued delivery propagates revocation through the shared consent state. Direct delivery leaves propagation to the host. A request already accepted by the receiver can remain there after revocation.

## Delivery

The HTTP/JSON sender omits ambient credentials and the referrer. The receiver requires an explicit access policy. Its bearer mode checks authenticated claims against the configured audience, expiry, tenant, application, and `liatris:write` permission before processing the body. The demo selects direct loopback access.

The local reference receiver accepts HTTP/JSON, checks the profile hash and payload, and responds after its sink completes. The demo sink commits the record to SQLite before acknowledging it and prints its category to the terminal.

Delivery adapters share the same validation, acknowledgement and error contract. The Kinesis worker forwards accepted records from SQLite. gRPC options include unary gRPC-Web towards the receiver and native gRPC forwarding from the receiver. See [durable event delivery](delivery.md) for the bounded queue, retry policy, receiver-side deduplication using `event_id` and Kinesis forwarding. Browser unload and offline recovery require separate tests. [gRPC-Web protocol](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-WEB.md)

For search analysis, track exposures independently of clicks. Record the displayed result set and ranking version when measuring ranking changes. See [event contracts](event-contracts.md) for example integration points.
