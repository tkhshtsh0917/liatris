# Integrate Liatris into a search page

[日本語](ja/integration.md)

This guide starts with three events for one search surface. Record the submitted search, the list that actually rendered, and a result click. The application supplies its search context and consent. Liatris validates its events, assigns the session, and manages delivery.

## 1. Verify the sample end to end

From the Liatris checkout with the pinned Node.js and Rust toolchains:

```sh
mise exec -- npm ci
mise run wasm
mise exec -- npm run demo
```

Open [the demo](http://127.0.0.1:4173/), enable collection, search for **garden tools**, then click **Garden spade**. In the browser's Network panel, open requests to `/api/ubi` and inspect the records in the JSON array. The terminal shows accepted event names. The local demo serves both the page and the receiver on that loopback origin.

| Check | Expected result |
| --- | --- |
| Search submission | `search_submitted` has a `query_id` and no search text in its payload. |
| Display | `results_shown` has the same `query_id`, plus `metadata.result_set`, `metadata.result_count: 2`, and `metadata.ranking_version`. |
| Click | `click` has the same `query_id` and `metadata.result_set`. The displayed rank is `event_attributes.position.ordinal: 2` and the object ID is `event_attributes.object.object_id: "spade"`. |
| Empty results | The **no results** search produces `results_shown` with `result_count: 0`. |
| Receipt | The reference receiver returns HTTP 200 with an `accepted` receipt for each saved `event_id`. |

The demo also sends an optional UBI Query record with synthetic search text. The three-event integration below collects no search text.

## 2. Install the browser SDK and compile a profile

Download `liatris-browser.tar.gz` and `SHA256SUMS` from the same [GitHub release](https://github.com/tkhshtsh0917/liatris/releases). Verify the archive and extract it. Development builds can generate the same files in `dist/sdk/` with `mise run wasm` followed by `mise exec -- npm run sdk:build`.

```sh
shasum -a 256 -c SHA256SUMS && tar -xzf liatris-browser.tar.gz
```

From the matching source tag with the Node.js dependencies installed, copy the standalone example profile and set your `tenant`, `application`, and collection `endpoint`. This profile declares search submissions, result displays, impressions, and clicks with search text disabled. It uses the UBI compatibility mode for the standard click event. [Schema modes](design.md#ubi-and-sessions)

```sh
cp examples/browser/profile.toml my-service.toml
# Edit my-service.toml before compiling.
artifact_dir=$(mktemp -d)
mise exec -- npm run --silent profile -- my-service.toml "$artifact_dir/profile.json" > "$artifact_dir/profile.sha256"
```

Serve the following files on your application's HTTPS origin. Use a JavaScript MIME type for the ES modules and `application/wasm` for the session module. If you set a Content Security Policy, allow the module's origin and WASM execution in `script-src`. Allow the intake origin in `connect-src`.

| Source | URL in your app |
| --- | --- |
| All `.js` files in `liatris-browser/`, with relative imports intact | `/assets/liatris/` |
| `liatris-browser/session.wasm` | `/assets/liatris/session.wasm` |
| `$artifact_dir/profile.json` and `$artifact_dir/profile.sha256` | `/assets/liatris/profile.json` and `/assets/liatris/profile.sha256` |

The archive includes `.d.ts` files alongside the JavaScript for TypeScript tooling. Use the same compiled profile and hash in the receiving application, and deploy the browser and receiver configuration together. The [standalone browser example](../examples/browser/) uses these public paths, and CI tests it against the extracted archive.

## 3. Initialize the collector in your app

Load this in your browser entry point or an ES module. Replace `obtainWriteToken` with the application function that obtains a scoped token for the collection API. Pass the state from your consent UI to `setMeasurementConsent` at initialization and when it changes. Wait for the update before starting collection.

```js
import { createCollector, createHttpBatchDelivery } from "/assets/liatris/collector.js";
import { createQueuedDelivery } from "/assets/liatris/queued-delivery.js";
import { createSearchMeasurement } from "/assets/liatris/search-measurement.js";

async function asset(name) {
  const url = new URL(`/assets/liatris/${name}`, location.origin);
  const response = await fetch(url, {
    credentials: "omit",
  });
  if (!response.ok) throw new Error(`Could not load Liatris asset ${name}`);
  return response;
}

export async function createSearchTracking(obtainWriteToken) {
  const [profile, hash] = await Promise.all([
    asset("profile.json").then(response => response.json()),
    asset("profile.sha256").then(response => response.text()),
  ]);
  const profileHash = hash.trim();
  const sendBatch = createHttpBatchDelivery(profile.endpoint, {
    getAccessToken: obtainWriteToken,
  });
  const collector = createCollector({
    profile,
    profileHash,
    queue: createQueuedDelivery({ profile, profileHash, sendBatch }),
    loadWasm: async () => (await asset("session.wasm")).arrayBuffer(),
  });
  const search = createSearchMeasurement(collector);

  return {
    collector,
    search,
    setMeasurementConsent(granted) {
      if (!granted) search.clear();
      return collector.setConsent(granted);
    },
  };
}
```

## 4. Add three calls at the application boundaries

| Where to call | What your application supplies |
| --- | --- |
| When the user submits a search | Call `search.beginSearch(queryId)`. Generate an opaque ID for the search, reuse it for retries, and keep the returned object with that request. |
| When the response is ready to render | Call `request.render({ resultCount, rankingVersion }, draw)` with the count shown and version selected by your app. Synchronously render inside `draw(display)`. Keep `display` with the rendered cards for their click handlers. In asynchronous UI frameworks, connect measurement to the actual commit. The callback can receive `undefined` when measurement is inactive. |
| When a visible result is clicked | Call `collector.trackEvent("click", ...)` with the display context and the card's ID and displayed rank. Use each card's own display context even when another query is pending. |

Use the event's promise for error reporting. Keep search navigation and business actions responsive while collecting logs. The runnable demo shows the full call sites, including optional impressions and dwell time. [Demo source](../demo/browser.ts)

For the third call, `itemId` and `displayedRank` come from your result renderer. Use a stable, opaque item ID and a rank starting at 1.

```js
if (display) {
  void collector.trackEvent("click", {
    query_id: display.queryId,
    event_attributes: {
      position: { ordinal: displayedRank },
      object: { object_id: itemId },
    },
    metadata: { result_set: display.resultSet },
  }).catch(() => console.error("Liatris capture failed"));
}
```

## 5. Connect your receiver

Host a POST route at the profile's `endpoint`, preferably on the application's HTTPS origin. For the Node.js reference implementation, mount `createHttpReceiver(profile, profileHash, store.accept, { audience, verifyBearer, acceptBatch: store.acceptBatch })` at that route with a store created by `openEventStore(path, profile)`. Load `profile` and `profileHash` from the two compiled files you served in step 2. Use `trim()` to strip the newline from the hash file. `verifyBearer` authenticates each token and returns the verified tenant, application, audience, `liatris:write` permission, and expiry. An existing receiver can implement the same HTTP contract. [Receiver entry point](../server/http.ts) · [Durable delivery](delivery.md) · [Authentication and production controls](security.md)

Repeat the checks in step 1 against your own page, then withdraw consent and try another search. A working integration renders the results and produces no new collection POST after withdrawal. The immediate `queued` result shows local storage in the browser. An `accepted` receipt in the response body confirms durable storage for that event.
