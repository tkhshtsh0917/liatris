# 検索画面に Liatris を組み込む

[English](../integration.md)

まず一つの検索画面で、検索開始・実際に表示した結果・結果のクリックを記録します。導入先のアプリケーションは、検索の文脈と同意状態を渡します。Liatris がイベントの検証、セッションの付与、配送を担当します。

## 1. デモで一連の動作を確認する

Liatris のチェックアウトで次を実行します。

```sh
mise install
mise exec -- npm ci
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

公開済みの SDK を使う場合は、対応するソースタグの導入ガイドを参照します。同じリリースから `liatris-browser.tar.gz` と `SHA256SUMS` をダウンロードし、ダウンロード先で次のコマンドを実行します。[GitHub Releases](https://github.com/tkhshtsh0917/liatris/releases)

```sh
shasum -a 256 -c SHA256SUMS && tar -xzf liatris-browser.tar.gz
```

開発用のチェックアウトで SDK を試す場合は、手順1と同じ方法で依存関係をインストールして `mise exec -- npm run sdk:build` を実行します。展開済みのファイルは `dist/sdk/liatris-browser/` に生成されます。

SDK と同じソースをチェックアウトし、手順1と同じ方法で依存関係をインストールしてから、独立サンプルのプロファイルをコピーし、`tenant`、`application`、収集先の `endpoint` を設定します。このプロファイルは検索開始、結果表示、露出、クリックを宣言し、検索語の収集を無効にします。標準のクリックイベントには UBI の互換モードを使います。[スキーマモード](design.md#ubi-とセッション)

```sh
cp examples/browser/profile.toml my-service.toml
# コンパイルする前に my-service.toml を編集する。
artifact_dir=$(mktemp -d)
mise exec -- npm run --silent profile -- my-service.toml "$artifact_dir/profile.json" > "$artifact_dir/profile.sha256"
```

以下のファイルを導入先の HTTPS オリジンから配信します。ES モジュールには JavaScript の MIME タイプを設定します。Content Security Policy を設定している場合は、`script-src` でモジュールのオリジンを、`connect-src` でプロファイルの配信元とイベントの収集先のオリジンを許可します。

| 配信元 | 導入先の URL |
| --- | --- |
| `liatris-browser/` にあるすべての `.js` ファイル。相対 import はそのまま保ちます。 | `/assets/liatris/` |
| `$artifact_dir/profile.json` と `$artifact_dir/profile.sha256` | `/assets/liatris/profile.json` と `/assets/liatris/profile.sha256` |

アーカイブにはブラウザ SDK と TypeScript の型宣言が入っています。プロファイルのコンパイラとリファレンス受信実装は、チェックアウトしたソースから実行します。受信側にも同じコンパイル済みプロファイルとハッシュを渡し、ブラウザと受信側の設定を一緒に配備します。[独立したブラウザサンプル](../../examples/browser/)は上記の公開パスを使い、CI ではアーカイブを展開して動作を検証します。

## 3. アプリケーションで初期化する

ブラウザのエントリーポイント、または ES モジュールで読み込みます。`obtainWriteToken` には、収集 API 用のスコープ限定トークンを取得する導入先の関数を渡します。

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

コレクターは収集を無効にした状態で起動します。導入先が利用者の同意状態を読み込んでいる間や、利用者がまだ選択していない間は、この初期状態を維持してください。保存済みの同意を復元する場合も含め、同意を確認できたら `setMeasurementConsent(true)` を呼び、完了を待ちます。明示的な撤回を反映するときは `setMeasurementConsent(false)` を呼び、完了を待ちます。キュー配送では、同じ収集スコープの共有セッションと未送信イベントが削除されます。別タブで発生したイベントも対象です。起動時にチェックボックスが未選択でも、同意状態が未確定の場合があります。

利用者の同意の判断は導入先で保持してください。キュー配送で撤回が失敗すると、コレクターモジュールから公開される `ConsentWithdrawalError` が発生します。エラーに `retry` があれば、未完了の撤回と一緒にそのオブジェクトを保存してください。再読み込み後は保存した値を復元し、収集を有効にする前に `await collector.retryConsentWithdrawal(retry)` を呼びます。この再試行は元の同意を対象とし、新しい同意を維持します。呼び出しが成功したら保存済みの値を削除します。デモではタブ内の `sessionStorage` を使って再読み込み後に値を引き継ぎます。

`retry` がない場合、SDK は削除対象の世代を特定できていません。収集を停止した状態で、導入先が持つ最新の同意の判断を確認してから新たに撤回してください。IndexedDB に撤回の記録が保存されていれば、削除が完了するまで送信待ちイベントは配送されません。[永続配送](delivery.md)

同意を反映した後は `collector.consentSignal` から有効な同意のシグナルを取得できます。その `abort` イベントを購読し、同意画面の表示を更新して監視処理を停止してください。収集が無効なら、このプロパティは `undefined` を返します。キュー配送では、別タブでの撤回でもシグナルが中断されることがあります。同意を得るたびに、プロパティからシグナルを取得し直してください。独立したブラウザサンプルに、チェックボックスとの連携と撤回の再試行を提供する実装があります。[サンプルのソース](../../examples/browser/app.mjs)

同意状態が変わっても、進行中の検索は応答を受け取って描画できます。利用者が画面を離れるなど、検索自体を取り消す場合は `search.clear()` を呼びます。

## 4. アプリケーションの3か所から収集 API を呼ぶ

| 呼び出す場所 | 導入先が渡す情報 |
| --- | --- |
| 利用者が検索を確定したとき | `search.beginSearch(queryId)` を呼びます。検索ごとに不透明な ID を作り、通信の再試行では同じ ID を使います。戻り値をそのリクエストと一緒に保持します。 |
| 応答を表示できるようになったとき | `request.render({ resultCount, rankingVersion }, draw)` に、実際の表示件数と採用した順位付けの版を渡します。`draw(display)` の中で同期的に一覧を描画し、クリック時に使う `display` をそれぞれのカードと一緒に保持します。非同期描画のフレームワークでは、表示が確定する箇所に計測をつなぎます。同意などで計測が無効な場合、`display` は `undefined` になります。 |
| 表示中の結果をクリックしたとき | `collector.trackEvent("click", ...)` に、そのカードの表示時の文脈、アイテム ID、表示順位を渡します。同意シグナルが有効な間は、クリックされたカードの表示時の文脈を使います。 |

`request.submitted` とクリック時の `trackEvent` の Promise でエラーを処理します。`request.render` が Promise を返した場合も同様に処理します。検索の画面遷移や業務処理は収集結果を待たずに進めます。デモのソースでは、必要に応じて追加できる露出・滞在時間も含めて、実際の呼び出し箇所が確認できます。[デモのソース](../../demo/browser.ts)

クリック時の `itemId` と `displayedRank` はアプリケーションの描画処理で決まります。安定した不透明なアイテム ID と、1 始まりの表示順位を渡します。カード本来の操作は計測の条件判定の外で実行します。同意を撤回すると、その表示にひも付くシグナルが中止され、クリックと露出の計測が止まります。再同意は以後の検索に適用されます。

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

## 5. 受信 API をつなぐ

プロファイルの `endpoint` に POST ルートを用意します。アプリケーションと同じ HTTPS オリジンでの配信を基本とします。Node.js の参考実装なら、`openEventStore(path, profile)` で保存先を作り、そのルートで `createHttpReceiver(profile, profileHash, store.accept, { audience, verifyBearer, acceptBatch: store.acceptBatch })` を使います。`profile` と `profileHash` は手順2で配信した二つのコンパイル済みファイルから読み、ハッシュファイルの末尾の改行は `trim()` で除きます。`verifyBearer` はトークンを認証し、検証済みのテナント、アプリケーション、対象サービス、`liatris:write` 権限、有効期限を返します。既存の受信 API を使う場合は、同じ HTTP 契約で受け付けます。ブラウザと受信 API のオリジンが異なる場合は、ゲートウェイまたは HTTP サーバーで `OPTIONS` のプリフライトを含む CORS を設定します。[受信側の入口](../../server/http.ts) · [永続配送](delivery.md) · [認証と本番公開の条件](security.md)

自分のページで手順1と同じ確認をしたら、検索を開始し、応答を待っている間に同意を撤回します。検索結果が表示され、新しい収集 POST が発生しないことを確認します。再同意後は撤回前のカードをクリックして通常の操作ができることを確認します。次に記録されるクリックは、新たに検索した結果のカードをクリックしたときのものです。すぐに返る `queued` はブラウザ内への保存を表し、受信側の応答本文の `accepted` が、そのイベントの永続保存を確認する応答です。
