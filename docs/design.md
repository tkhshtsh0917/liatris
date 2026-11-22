# Liatris design

[日本語](ja/design.md)

## Collection and event contracts

A TypeScript host handles application calls, the browser clock, Web Crypto, IndexedDB, and delivery. Rust/WASM currently decides when the session expires. The application declares event names and fields in JSON, YAML, or TOML and calls `trackQuery` and `trackEvent` at domain-specific points. The compiler produces equivalent normalized JSON and a SHA-256 profile identifier for the browser and receiver. A site must explicitly enable query text capture.

The host supplies the query ID that belongs to the displayed result, the result ID and its 1-based visible rank. A Search API that already emits the Query record can provide its ID for browser-side clicks. Event-specific custom fields are validated in envelope metadata. Supported UBI extension paths are validated against the profile and embedded in the UBI payload. Position is required when supplying `event_attributes`.

## UBI and sessions

The receiver verifies the collection contract and the selected [UBI v1.3.0 schema](../schema/upstream/ubi-1.3.0/README.md). Strict validation is the default. The compatibility option addresses overlapping schema branches for known action names and object types. The sample uses compatibility mode to submit a `click` on a `product`.

The default session timeout is 30 minutes of inactivity. Same-origin tabs can share session state through one IndexedDB transaction per activity. Consent starts disabled in each collector. Revocation stops collection, aborts pending delivery and deletes the persisted session for the configured application. The host must propagate consent changes to its other tabs. A request already accepted by the receiver can remain there after revocation.

## Delivery

The local reference receiver accepts HTTP/JSON, checks the profile hash and payload, and responds after its sink completes. The demo sink prints accepted records to the terminal. Its acknowledgement reflects that sink's behavior. A production sink should persist or enqueue the record durably before acknowledging it.

Future adapters should share the same validation, acknowledgement and error contract. Browser-to-receiver RPC can use unary gRPC-Web against a compatible endpoint. Receiver-to-service forwarding can use native gRPC or a Kinesis adapter. The next delivery milestone adds a bounded queue, retry policy and receiver-side deduplication using `event_id`. Browser unload and offline recovery require separate tests. [gRPC-Web protocol](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-WEB.md)

For search analysis, track exposures independently of clicks. Record the displayed result set and ranking version when measuring ranking changes. See [event contracts](event-contracts.md) for example integration points.
