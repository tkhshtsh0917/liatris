# 検索画面に Liatris を組み込む

[English](../integration.md)

まず一つの検索画面で、検索開始・実際に表示した結果・結果のクリックを記録します。導入先のアプリケーションは、検索の文脈と同意状態を渡します。Liatris がイベントの検証、セッションの付与、配送を担当します。

## 1. デモで一連の動作を確認する

Liatris のチェックアウトで、指定の Node.js と Rust のツールチェーンを使います。

```sh
mise exec -- npm ci
mise run wasm
mise exec -- npm run demo
```

[デモ](http://127.0.0.1:4173/)を開き、収集を許可し、**garden tools** で検索して **Garden spade** をクリックします。ブラウザの開発者ツールの Network で、`/api/ubi` へのリクエストを開き、JSON 配列内のレコードを確認します。ターミナルには受信したイベント名が出ます。デモはページと受信 API を同じループバックのオリジンで提供します。

| 確認すること | 期待される結果 |
| --- | --- |
| 検索開始 | `search_submitted` のペイロードに `query_id` があり、検索語は含まれません。 |
| 結果表示 | `results_shown` に同じ `query_id` があり、`metadata.result_set`、`metadata.result_count: 2`、`metadata.ranking_version` が付きます。 |
| クリック | `click` に同じ `query_id` と `metadata.result_set` が付きます。表示順位は `event_attributes.position.ordinal: 2`、アイテム ID は `event_attributes.object.object_id: "spade"` です。 |
| ゼロ件表示 | **no results** で検索すると、`result_count: 0` の `results_shown` が記録されます。 |
| 受領 | リファレンス受信側の HTTP 200 の本文に、保存された各 `event_id` の `accepted` が含まれます。 |

デモではサンプルの検索語を含む UBI Query も任意の別レコードとして送ります。以下の3イベントの組み込み例は検索語を収集しません。

## 2. ブラウザ SDK を配置し、プロファイルをコンパイルする

同じ [GitHub リリース](https://github.com/tkhshtsh0917/liatris/releases)から `liatris-browser.tar.gz` と `SHA256SUMS` をダウンロードします。アーカイブを検証して展開します。開発時は `mise run wasm` に続けて `mise exec -- npm run sdk:build` を実行すると、同じ構成のファイルを `dist/sdk/` に生成できます。

```sh
shasum -a 256 -c SHA256SUMS && tar -xzf liatris-browser.tar.gz
```

配布物と同じタグのソースで Node.js の依存関係をインストールしてから、独立サンプルのプロファイルをコピーし、`tenant`、`application`、収集先の `endpoint` を設定します。このプロファイルは検索開始、結果表示、露出、クリックを宣言し、検索語の収集を無効にします。標準のクリックイベントには UBI の互換モードを使います。[スキーマモード](design.md#ubi-とセッション)

```sh
cp examples/browser/profile.toml my-service.toml
# コンパイルする前に my-service.toml を編集する。
artifact_dir=$(mktemp -d)
mise exec -- npm run --silent profile -- my-service.toml "$artifact_dir/profile.json" > "$artifact_dir/profile.sha256"
```

以下のファイルを導入先の HTTPS オリジンから配信します。ES モジュールには JavaScript の MIME タイプを、セッションモジュールには `application/wasm` を設定します。Content Security Policy を設定している場合は、`script-src` でモジュールのオリジンと WASM の実行を許可し、`connect-src` で収集先のオリジンを許可します。

| 配信元 | 導入先の URL |
| --- | --- |
| `liatris-browser/` にあるすべての `.js` ファイル。相対 import はそのまま保ちます。 | `/assets/liatris/` |
| `liatris-browser/session.wasm` | `/assets/liatris/session.wasm` |
| `$artifact_dir/profile.json` と `$artifact_dir/profile.sha256` | `/assets/liatris/profile.json` と `/assets/liatris/profile.sha256` |

アーカイブには TypeScript の開発ツールで使う `.d.ts` が JavaScript と同梱されています。受信側にも同じコンパイル済みプロファイルとハッシュを渡し、ブラウザと受信側の設定を一緒に配備します。[独立したブラウザサンプル](../../examples/browser/)は上記の公開パスを使い、CI ではアーカイブを展開して動作を検証します。

## 3. アプリケーションで初期化する

ブラウザのエントリーポイント、または ES モジュールで読み込みます。`obtainWriteToken` には、収集 API 用のスコープ限定トークンを取得する導入先の関数を渡します。初期化時と同意状態が変わるたびに、同意画面の状態を `setMeasurementConsent` に渡し、処理の完了を待ってから計測を開始します。

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

## 4. アプリケーションの3か所から収集 API を呼ぶ

| 呼び出す場所 | 導入先が渡す情報 |
| --- | --- |
| 利用者が検索を確定したとき | `search.beginSearch(queryId)` を呼びます。検索ごとに不透明な ID を作り、通信の再試行では同じ ID を使います。戻り値をそのリクエストと一緒に保持します。 |
| 応答を表示できるようになったとき | `request.render({ resultCount, rankingVersion }, draw)` に、実際の表示件数と採用した順位付けの版を渡します。`draw(display)` の中で同期的に一覧を描画し、クリック時に使う `display` をそれぞれのカードと一緒に保持します。非同期描画のフレームワークでは、表示が確定する箇所に計測をつなぎます。同意などで計測が無効な場合、`display` は `undefined` になります。 |
| 表示中の結果をクリックしたとき | `collector.trackEvent("click", ...)` に、そのカードの表示時の文脈、アイテム ID、表示順位を渡します。次の検索が進行中でも、クリックされたカードにひも付く値を使います。 |

収集 Promise はエラー報告に使い、検索の画面遷移や業務処理は収集結果を待たずに進められます。デモのソースでは、必要に応じて追加できる露出・滞在時間も含めて、実際の呼び出し箇所が確認できます。[デモのソース](../../demo/browser.ts)

クリック時の `itemId` と `displayedRank` はアプリケーションの描画処理で決まります。安定した不透明なアイテム ID と、1 始まりの表示順位を渡します。

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

## 5. 受信 API をつなぐ

プロファイルの `endpoint` に POST ルートを用意します。アプリケーションと同じ HTTPS オリジンでの配信を基本とします。Node.js の参考実装なら、`openEventStore(path, profile)` で保存先を作り、そのルートで `createHttpReceiver(profile, profileHash, store.accept, { audience, verifyBearer, acceptBatch: store.acceptBatch })` を使います。`profile` と `profileHash` は手順2で配信した二つのコンパイル済みファイルから読み、ハッシュファイルの末尾の改行は `trim()` で除きます。`verifyBearer` はトークンを認証し、検証済みのテナント、アプリケーション、対象サービス、`liatris:write` 権限、有効期限を返します。既存の受信 API を使う場合は、同じ HTTP 契約で受け付けます。[受信側の入口](../../server/http.ts) · [永続配送](delivery.md) · [認証と本番公開の条件](security.md)

自分のページで手順1と同じ確認をしたら、同意を撤回してもう一度検索します。検索結果が表示され、撤回後の新しい収集 POST が出なければ、組み込みの確認は完了です。すぐに返る `queued` はブラウザ内への保存を表し、受信側の応答本文の `accepted` が、そのイベントの永続保存を確認する応答です。
