# Durable event delivery

[日本語](ja/delivery.md)

## Browser and intake

Pass a `createQueuedDelivery` instance as the collector's `queue` option. Give it the application profile, its hash, and a `createHttpDelivery(endpoint, { requireAcknowledgement: true })` sender. Grant consent through the collector before capture. A `queued` status means IndexedDB committed the envelope. HTTP 204 acknowledges durable receipt. The direct collector mode returns `sent` when its configured delivery resolves.

The queue stores up to 64 events per origin, tenant and application. Eligible events expire after 24 hours, and the queue removes expired entries when it is active. A full queue rejects new events. The sender retries transient failures with the same envelope and event ID, honors bounded `Retry-After` delays, and drops definitive rejections. Tokens are obtained for each request and stay outside the queue. Retry resumes on consent, reconnect or a visibility change.

Tabs share a consent generation, session and queue in IndexedDB. A withdrawal deletes the session and pending events in one transaction, changes the generation, and aborts active delivery in tabs that receive the notice. Late callbacks recheck the generation before updating storage. A request that already reached the collector service may have been accepted. Removal of received data is a server-side operation.

The reference intake commits accepted events to SQLite before returning 204. Reposting the same envelope returns 204 and leaves one stored event. A different envelope with the same ID and tenant/application returns 409. Set `LIATRIS_DB` to choose the database path. By default the demo uses `liatris-demo.sqlite`. Establish retention and deletion policies and protect the database file before storing production data.

## Kinesis forwarding and verification

Run one forwarding worker per SQLite outbox and stream. Provide `LIATRIS_KINESIS_STREAM`, `AWS_REGION` and a server-side AWS credential provider. The worker uses `LIATRIS_DB` and accepts `LIATRIS_PROFILE` as the path to a TOML profile for selecting the tenant and application. It uses HTTP/1.1 when a plain HTTP Kinesis endpoint override is configured for local tests.

```sh
npm run forward:kinesis
npm run test:kinesis
```

The Compose test submits through the reference HTTP receiver, repeats delivery for one event ID, and checks the envelope after reading it back from Moto. The unit test verifies partial batch responses. A crash after Kinesis accepts a record but before SQLite marks it forwarded can lead to another delivery. Consumers should deduplicate by `event_id`. Validate production IAM policy and limits against AWS.

For browser delivery tests, build the WASM with `mise run wasm`, install Chromium, Firefox and WebKit with `npx playwright install chromium firefox webkit`, and run `npm run test:browser`. The suite checks lost acknowledgements, storage across reloads and revocation from another tab.
