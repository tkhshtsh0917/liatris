# Integrate Liatris into a search page

[日本語](ja/integration.md)

This guide starts with three events for one search surface. Record the submitted search, the list that actually rendered, and a result click. The application supplies its search context and consent. Liatris validates its events, assigns the session, and manages delivery.

## 1. Verify the sample end to end

Run these commands from the Liatris checkout.

```sh
mise install
mise exec -- npm ci
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

For a released SDK, read the guide at the matching source tag. Download `liatris-browser.tar.gz` and `SHA256SUMS` from the same release and run the following command in the download directory. [GitHub Releases](https://github.com/tkhshtsh0917/liatris/releases)

```sh
shasum -a 256 -c SHA256SUMS && tar -xzf liatris-browser.tar.gz
```

To try the SDK from a development checkout, install the dependencies as in step 1 and run `mise exec -- npm run sdk:build`. The extracted files are then available in `dist/sdk/liatris-browser/`.

In the source checkout used for your SDK, install the dependencies as in step 1 and copy the standalone example profile and set your `tenant`, `application`, and collection `endpoint`. This profile declares search submissions, result displays, impressions, and clicks with search text disabled. It uses the UBI compatibility mode for the standard click event. [Schema modes](design.md#ubi-and-sessions)

```sh
cp examples/browser/profile.toml my-service.toml
# Edit my-service.toml before compiling.
artifact_dir=$(mktemp -d)
mise exec -- npm run --silent profile -- my-service.toml "$artifact_dir/profile.json" > "$artifact_dir/profile.sha256"
```

Serve the following files on your application's HTTPS origin. Use a JavaScript MIME type for the ES modules. If you set a Content Security Policy, allow the module's origin in `script-src`. Allow the origins serving the profile and receiving events in `connect-src`.

| Source | URL in your app |
| --- | --- |
| All `.js` files in `liatris-browser/`, with relative imports intact | `/assets/liatris/` |
| `$artifact_dir/profile.json` and `$artifact_dir/profile.sha256` | `/assets/liatris/profile.json` and `/assets/liatris/profile.sha256` |

The archive contains the browser SDK and its TypeScript declarations. Run the profile compiler and the reference receiver from the source checkout. Use the same compiled profile and hash in the receiving application, and deploy the browser and receiver configuration together. The [standalone browser example](../examples/browser/) uses these public paths, and CI tests it against the extracted archive.

## 3. Initialize the collector in your app

Load this in your browser entry point or an ES module. Replace `obtainWriteToken` with the application function that obtains a scoped token for the collection API.

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
    queue: createQueuedDelivery({ profile, profileHash, sendBatch, parallelBatches: 2 }),
  });
  const search = createSearchMeasurement(collector);

  return {
    collector,
    search,
    setMeasurementConsent: collector.setConsent,
  };
}
```

The collector starts with collection disabled. While the host loads the user's consent decision, or while the user has yet to choose, leave the collector in that initial state. Call and await `setMeasurementConsent(true)` once you have confirmed consent, including when you restore a saved grant. Call and await `setMeasurementConsent(false)` to apply an explicit withdrawal. With queued delivery, this clears the shared session and unsent events for the collection scope, including those from other tabs. An unchecked checkbox at startup can simply mean the decision is still unknown.

Keep the user's consent decision in the host application and check the current decision when a tab starts. A new tab may have missed a withdrawal that could not be written to IndexedDB. For queued delivery, a failed withdrawal throws `ConsentWithdrawalError` from the collector module. If the error includes `retry`, save that object with the incomplete withdrawal. After reload, restore it and call `await collector.retryConsentWithdrawal(retry)` before enabling capture. This retry targets the original grant and preserves a newer grant. Clear the saved retry after the call succeeds. The demos use tab-local `sessionStorage` to carry this object across reloads.

An error without a retry object means the SDK could not identify the generation to clear. Keep collection paused and confirm the host's current consent decision before issuing a new withdrawal. When IndexedDB has committed the withdrawal marker, pending events stay blocked until deletion succeeds. [Durable delivery](delivery.md)

After granting consent, use `collector.consentSignal` to read the active grant and listen for its `abort` event to update the consent UI and stop observers. The getter returns `undefined` when collection is disabled. With queued delivery, a withdrawal in another tab can abort the signal. Read the getter again after each new grant. The standalone browser example shows how to connect this to a checkbox and offer a withdrawal retry. [Example source](../examples/browser/app.mjs)

A consent change leaves the current search request available for rendering. Use `search.clear()` when the host abandons the search, such as when the user leaves the surface.

## 4. Add three calls at the application boundaries

| Where to call | What your application supplies |
| --- | --- |
| When the user submits a search | Call `search.beginSearch(queryId)`. Generate an opaque ID for the search, reuse it for retries, and keep the returned object with that request. |
| When the response is ready to render | Call `request.render({ resultCount, rankingVersion }, draw)` with the count shown and version selected by your app. Synchronously render inside `draw(display)`. Keep `display` with the rendered cards for their click handlers. In asynchronous UI frameworks, connect measurement to the actual commit. The callback can receive `undefined` when measurement is inactive. |
| When a visible result is clicked | Call `collector.trackEvent("click", ...)` with the display context and the card's ID and displayed rank. Use the card's own display context while its consent signal is active. |

Handle errors from `request.submitted`, the optional promise returned by `request.render`, and the click's `trackEvent` promise. Keep search navigation and business actions responsive while collecting logs. The runnable demo shows the full call sites, including optional impressions and dwell time. [Demo source](../demo/browser.ts)

For the third call, `itemId` and `displayedRank` come from your result renderer. Use a stable, opaque item ID and a rank starting at 1. Keep the card's normal action outside the tracking check. Consent withdrawal aborts the old display signal for both clicks and impressions. A fresh consent grant applies to subsequent searches.

```js
if (display && !display.signal.aborted) {
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

Host a POST route at the profile's `endpoint`, preferably on the application's HTTPS origin. For the Node.js reference implementation, mount `createHttpReceiver(profile, profileHash, store.accept, { audience, verifyBearer, acceptBatch: store.acceptBatch })` at that route with a store created by `openEventStore(path, profile)`. Load `profile` and `profileHash` from the two compiled files you served in step 2. Use `trim()` to strip the newline from the hash file. `verifyBearer` authenticates each token and returns the verified tenant, application, audience, `liatris:write` permission, and expiry. An existing receiver can implement the same HTTP contract. If the browser and intake are on different origins, configure the gateway or your HTTP server to handle CORS, including the `OPTIONS` preflight. [Receiver entry point](../server/http.ts) · [Durable delivery](delivery.md) · [Authentication and production controls](security.md)

Repeat the checks in step 1 against your own page. Start a search and withdraw consent while the response is pending. Confirm the results appear and the page sends no new collection POST. Regrant consent and click a card from the pre-withdrawal results. Its normal action should work, and a click from a fresh search should be the next click recorded. The immediate `queued` result shows local storage in the browser. An `accepted` receipt in the response body confirms durable storage for that event.
