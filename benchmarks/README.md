# Delivery performance checks

Run the checks from the repository root with the pinned toolchains. Install dependencies with `mise exec -- npm ci` and the three browser engines with `npx playwright install chromium firefox webkit`.

```sh
mise run wasm
mise exec -- npm run demo:build
mise exec -- node benchmarks/delivery.ts server
mise exec -- node benchmarks/delivery.ts server-batch
mise exec -- node benchmarks/delivery.ts browser
mise exec -- node benchmarks/delivery.ts session-replay
mise exec -- node benchmarks/delivery.ts forwarder
```

Run each command separately on an idle machine. Each writes JSON lines with the runtime and measurement conditions.
- **Receiver.** Sends synthetic UBI impressions through the HTTP receiver, a local token verifier, schema validation, and SQLite WAL with durable commits (one transaction per accepted HTTP batch on v0.2 and later). The `server` mode posts one event at a time. The `server-batch` mode posts up to 32 events at a time and validates every receipt. Each concurrency level warms up with 250 events and measures three runs of 2,000 events. Reported latency is per HTTP request. The generator and receiver share one Node.js process on loopback.
- **Browser.** Registers visible cards with the real impression observer and sends capture events through the collector, IndexedDB queue and HTTP transport. The browser route simulates the acknowledgement delay and returns one receipt per event. `enqueueP95` is the delay from the observer callback to persistent queuing for accepted events. `ackP95` is the delay from starting the burst to HTTP acknowledgement for accepted events. A click immediately after the burst tests remaining capacity and records its own acknowledgement time as `clickAckMs`. The output includes POST count and the largest batch seen.
- **Session replay.** Compares JavaScript, the scalar WASM function and an experimental WASM batch using the same numeric session decisions. The batch measurement includes copying the timestamps and reading back every decision. The experiment uses a separate module and excludes IndexedDB, UUID generation and network I/O.
- **Forwarder.** Launches the Kinesis worker with a local endpoint that acknowledges batches after a fixed delay. The idle scenario inserts one record about 200 ms after the preceding record was marked forwarded. The busy scenario measures 2,000 records from the first downstream request to confirmation of the last batch.

The browser runs measure queue behavior under a controlled acknowledgement delay. The receiver runs measure local file-backed intake with a local verifier. The forwarder runs measure polling, batching and acknowledged writes with a simulated downstream response.
