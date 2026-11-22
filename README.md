# Liatris

[日本語](README.ja.md)

Configurable browser event collection for User Behavior Insights, powered by Rust and WebAssembly.

Liatris uses a Rust/WASM session policy and a TypeScript collector. Configure event names and fields in TOML, YAML, or JSON, then call the collector from the application when each event occurs.

## Run the local demo

Install the Rust toolchain from [rust-toolchain.toml](rust-toolchain.toml) and Node.js from [mise.toml](mise.toml).

```sh
npm ci
mise run check
npm run demo
```

Open [the local demo](http://127.0.0.1:4173/), allow collection, search the sample catalog, and click the second result. The demo prints the accepted categories in the terminal. Inspect the local requests to see that the query, impressions and click share a query ID and session ID. The impressions and click also include the displayed result-set ID, and the click records rank 2. The **no results** sample captures a query without a click.

## Configure measurement

```toml
[impressions]
minVisiblePercent = 70

[session]
inactivityMinutes = 15
```

The defaults are 50% visible card area and 30 minutes of session inactivity. Omit the sections to use the defaults. Impression tracking requires the application to register its result cards. [Measurement contract](docs/event-contracts.md#card-impressions).

## Explore the integration

- [Collection profile](examples/shop.toml) declares allowed fields and opts in to query text for the synthetic demo. [YAML example](examples/shop.yaml).
- [Browser integration](demo/browser.ts) shows consent, search and click capture, and the HTTP/JSON transport.
- [Security and privacy](docs/security.md) covers cookies, consent, authentication and deployment controls.
- [Roadmap](docs/roadmap.md) tracks implementation and verification milestones.
- [Design](docs/design.md) explains UBI schema modes, session policy, and planned delivery adapters.
- [Event contracts](docs/event-contracts.md) shows how to define events for commerce and jobs.

To compile a profile separately, run `mkdir -p dist && npm run profile -- examples/shop.toml dist/shop.profile.json`. The compiler writes normalized JSON and prints its SHA-256.

The demo and reference receiver run locally. The tag distribution, durable queue, Kinesis, and gRPC adapters are planned.
