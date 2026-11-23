# Event projection experiment

[日本語](README.ja.md)

This experiment runs the same Rust profile rules as a browser WASM module and a native Node-API addon. It projects declared event inputs and query inputs to the same JSON-compatible fields used by the collector. The normal SDK and receiver have no dependency on these modules.

The TypeScript adapter checks that JavaScript objects have plain data properties before encoding them. It delegates inputs outside the JSON adapter's domain, such as unpaired UTF-16 surrogates and explicit undefined fields, to the existing implementation. The reference receiver still authenticates the request, checks the envelope and applies the pinned UBI schema.

## Verify and measure

Run from the repository root on a host with the pinned Node.js and Rust toolchains and a native linker. Install the project's npm dependencies and Playwright browsers first.

```sh
mise run event-core:check
mise exec -- npm run demo:build
mise exec -- node benchmarks/delivery.ts event-projection
mise exec -- node benchmarks/delivery.ts browser
mise exec -- node benchmarks/delivery.ts browser-rust
mise exec -- node benchmarks/delivery.ts server-batch
mise exec -- node benchmarks/delivery.ts server-batch-native
```

The projection benchmark includes the host snapshot, JSON serialization, transfer and return of an encoded result. It also tests 32 inputs per call. The browser and receiver runs use the normal application paths with a benchmark-only module override for the event and query projection functions. These runs measure the one-event API that the existing collector and receiver use.

The artifact for the browser is emitted separately from `session.wasm`. The native addon is built for the current host and the Rust build outputs stay in the experiment's `target/` directory. [Delivery benchmark conditions](../../benchmarks/README.md)
