# Delivery performance checks

Run the checks from the repository root with the pinned Node.js version. Install dependencies with `mise exec -- npm ci` and the three browser engines with `mise exec -- npx playwright install chromium firefox webkit`.

```sh
mise exec -- npm run demo:build
mise exec -- node benchmarks/delivery.ts server
mise exec -- node benchmarks/delivery.ts server-batch
mise exec -- node benchmarks/delivery.ts browser
mise exec -- node benchmarks/delivery.ts forwarder
```

Run each command separately on an idle machine. Each writes JSON lines with the runtime and measurement conditions.
- **Receiver.** Sends synthetic UBI impressions through the HTTP receiver, a local token verifier, schema validation, and SQLite WAL with durable commits (one transaction per accepted HTTP batch on v0.2 and later). The `server` mode posts one event at a time. The `server-batch` mode posts up to 32 events at a time and validates every receipt. Each concurrency level warms up with 250 events and measures three runs of 2,000 events. Reported latency is per HTTP request. The generator and receiver share one Node.js process on loopback.
- **Browser.** Registers visible cards with the real impression observer and sends capture events through the collector, IndexedDB queue and HTTP transport. The browser route simulates the acknowledgement delay and returns one receipt per event. `enqueueP95` is the delay from the observer callback to persistent queuing for accepted events. `ackP95` is the delay from starting the burst to HTTP acknowledgement for accepted events. A click immediately after the burst tests remaining capacity and records its own acknowledgement time as `clickAckMs`. The output includes POST count and the largest batch seen.
- **Forwarder.** Launches the Kinesis worker with a local endpoint that acknowledges batches after a fixed delay. The idle scenario inserts one record about 200 ms after the preceding record was marked forwarded. The busy scenario measures 2,000 records from the first downstream request to confirmation of the last batch.

The browser runs measure queue behavior under a controlled acknowledgement delay. The receiver runs measure local file-backed intake with a local verifier. The forwarder runs measure polling, batching and acknowledged writes with a simulated downstream response.

## Compare session startup against v0.2.0

Download `liatris-browser.tar.gz` and `SHA256SUMS` from the [v0.2.0 release](https://github.com/tkhshtsh0917/liatris/releases/tag/v0.2.0). Verify and extract the archive in a temporary directory, then pass the extracted `liatris-browser/` directory to the comparison from the repository root.

```sh
shasum -a 256 -c SHA256SUMS && tar -xzf liatris-browser.tar.gz
```

```sh
mise exec -- npm run demo:build
mise exec -- node benchmarks/delivery.ts browser-session /path/to/liatris-browser
```

The script first checks 11,575 session decisions against the released WASM. It then compares the released SDK with the current browser build in Chromium, Firefox and WebKit, alternating their order over three trials. Each run measures the first event through IndexedDB and an HTTP receipt, then measures a warm burst of 40 or 250 impressions. The mocked API responds after 0 ms for 40 impressions and after 40 ms for 250 impressions. Both builds run under the same API conditions. The additional 0 or 40 ms delay applies only to the old session module request. For a pooled summary of burst tail latency, take the median of the per-run `ackP95` values for each SDK and scenario.
