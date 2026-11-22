# Liatris roadmap

[日本語](ja/roadmap.md)

| Milestone | Scope | Acceptance criteria |
| --- | --- | --- |
| M0 · Collector foundation · complete | Compile JSON, YAML and TOML profiles, use a Rust/WASM inactivity policy, and accept a query and click through a local UBI receiver. | Equivalent inputs yield the same profile hash. Query and click correlate by query and session IDs. Strict and compatibility mode fixtures exercise the pinned UBI schemas. |
| M1 · Card impressions · initial implementation complete | Let the host register result cards. Configure minimum visible area and session inactivity. Link impressions and clicks to the same displayed result set. | Verify the inclusive 50% boundary, a custom threshold, foreground behavior, and one impression per rank and result set. Verify consent and clipping in Chromium, Firefox, WebKit and a mobile profile. |
| M2 · Search measurement · initial capture implemented | Record text-free search submissions, rendered result sets including zero, the ranking version and time to first click. | Join search, displayed set, impression and click without assigning stale responses to the latest query. Replay fixtures for zero results, visible results with no clicks, two result sets for one query, and reordered cards. Show separate query, visible impression and click denominators. |
| M3 · Reliable delivery and consent · reference path implemented | Add a bounded persistent queue, stable event IDs, receiver deduplication and acknowledgements after durable acceptance. Apply consent changes to the queue and active capture across tabs. | Test offline recovery, lost responses, throttling, quota errors, page backgrounding and consent revocation. Retry with unchanged IDs and capture context. Record the reason for dropped items without including their payloads. |
| M4 · Integration and transport · streaming adapter example implemented | Package the SDK and HTTP/JSON integration, document application event hooks, offer an optional script loader, add unary gRPC-Web or native gRPC forwarding, and provide a server-side adapter example for a low-latency streaming destination. | Replay equivalent fixtures across transports. Verify that extensions, record limits, acceptance semantics and transient-versus-permanent failures are preserved. Test CORS, timeouts and cancellation for browser RPC. Add reproducible CI and browser checks for the distribution. |
| M5 · Privacy-preserving aggregate experiments | Evaluate aggregate-only reporting separately when an actual sharing use case has been identified. Consider DAP where independent aggregation parties can be operated. | Define what the shared metrics must answer, the threat model and permitted privacy loss. Compare utility and operational cost with the existing aggregate pipeline before adding a protocol. |

Recent click-log studies motivate recording the displayed list and exposure independently of clicks in M2. Statistical bias correction and ranking models belong downstream, where experiments and denominators are available. [Baidu click-log study](https://arxiv.org/abs/2404.02543) · [Query-level click propensity study](https://arxiv.org/abs/2502.11414)

A queued browser Beacon and a durable receiver acknowledgement have different meanings. M3 treats receipt confirmation and consent as properties to test under failures. M5 follows the standardization work on privacy-preserving aggregation as a separate experiment. [W3C Beacon](https://www.w3.org/TR/beacon/) · [IETF DAP draft](https://datatracker.ietf.org/doc/draft-ietf-ppm-dap/)

M2 includes opt-in duration metrics and tests for inactivity and missing observations. The demo implements result dwell and session elapsed time at dwell checkpoints. [Metric definitions](event-contracts.md#duration-and-search-metrics)

See [search interaction log analysis](log-analysis.md) for unbiased ranking, dense retrieval training, and session-level experiments.

## Security and privacy release conditions

- **M2.** Capture search metrics without raw query text by default. Review each new field's purpose, data classification, destination and retention. Include proxy, application, debugging and backup paths in retention and deletion reviews.
- **M3.** Test cross-tab revocation and cleanup of identifiers and queued records, including failures. Preserve capture IDs on retries while bounding queue time and size. Apply request and concurrency limits before expensive verification and quotas per authenticated tenant. Reauthorize retries and confirm that authentication material never enters queue or sink logs.
- **M4.** Integrate a trusted credential issuer or store, enforce scoped credentials and key rotation, and verify the deployment's TLS and CORS settings. For external intake, test replay and abuse controls independently of token validity. Verify the SDK and WASM distribution, any bundled script loader, and dependency and runtime patch checks.

See [security and privacy](security.md) for the current controls and integration boundaries.
