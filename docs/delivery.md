# Durable event delivery

[日本語](ja/delivery.md)

## Browser and intake

Pass a `createQueuedDelivery` instance as the collector's `queue`. Give it the profile, its hash, and a `sendBatch` created with `createHttpBatchDelivery(endpoint)`. Grant consent through the collector before capture. A `queued` status means IndexedDB committed the envelope. Direct mode returns `sent` when its configured delivery resolves.

The queue holds up to 512 records per origin, tenant and application. It reserves the last 64 places for records other than `result_impression` and `impression`, and prioritizes those records among items ready to send. At the applicable limit, it rejects new records. Entries expire after 24 hours and are removed when the queue is active. Transient failures retry with the same content and event ID and honor bounded `Retry-After` delays. Tokens are obtained per request and stay outside the queue. Retry resumes on consent, reconnect or a visibility change.

Tabs share a consent generation, session and queue in IndexedDB. A withdrawal deletes the session and pending events in one transaction, changes the generation, and aborts active delivery in tabs that receive the notice. Late callbacks recheck the generation before updating storage. A request that already reached the collector service may have been accepted. Removal of received data is a server-side operation.

A batch is a JSON array sent as `application/vnd.liatris.batch+json`. Each request is limited to 32 records and 128 KiB, and each record to 32 KiB. The response is HTTP 200 with exactly one receipt per submitted `event_id`.

| Status | Queue behavior |
| --- | --- |
| `accepted` | Remove the record after the receiver confirms it was committed. |
| `rejected` | Remove the record after a permanent failure. |
| `retry` | Retain the record for retry after a transient failure. |

Missing, duplicate or unusable receipts cause the whole batch to be retried. The reference intake commits accepted events to SQLite before acknowledging them. A replay of identical content within the tenant and application still leaves one stored event. Reusing its event ID with different content is a permanent failure. Single-record `application/json` remains supported with HTTP 204 for acceptance and HTTP 409 for conflicting content. Set `LIATRIS_DB` to choose the database path. By default the demo uses `liatris-demo.sqlite`. Establish retention and deletion policies and protect the database file before storing production data.

## Streaming destination contract

Choose a low-latency streaming service for the deployment and connect it through a server-side adapter. Read committed events from the outbox, preserve the UBI envelope and `event_id`, and mark each event as forwarded only after the destination confirms acceptance. Keep unacknowledged records available for retry, including records that fail individually in a batch. Apply the destination's limits and error handling in the adapter. The browser and intake API use the same acknowledgement contract for every destination.

A process can stop after the destination accepts a record and before the outbox records that acceptance. Consumers can use `event_id` to deduplicate deliveries in their collection scope.

## Reference adapter for Amazon Kinesis Data Streams

Run one forwarding worker per SQLite outbox and stream. Provide `LIATRIS_KINESIS_STREAM`, `AWS_REGION` and a server-side AWS credential provider. The worker uses `LIATRIS_DB` and accepts `LIATRIS_PROFILE` as the path to a TOML profile for selecting the tenant and application. It uses HTTP/1.1 when a plain HTTP Kinesis endpoint override is configured for local tests.

```sh
npm run forward:kinesis
npm run test:kinesis
```

The Compose test submits a single event and a batch through the reference HTTP receiver, repeats one ID across the two requests, and checks both envelopes after reading them from Moto. The unit test verifies partial batch responses. Scope the AWS role to writing the selected stream, and validate the production IAM policy and service limits against AWS. [Kinesis IAM documentation](https://docs.aws.amazon.com/streams/latest/dev/controlling-access.html)

For browser delivery tests, build the WASM with `mise run wasm`, install Chromium, Firefox and WebKit with `npx playwright install chromium firefox webkit`, and run `npm run test:browser`. The suite checks lost acknowledgements, storage across reloads, revocation from another tab, priority under impression pressure, partial receipts and migration of the previous queue format, offline recovery, 429 backoff, quota recovery and delivery after a suspended page becomes visible. Capturing new events while offline requires the page to have already loaded the session WASM.
