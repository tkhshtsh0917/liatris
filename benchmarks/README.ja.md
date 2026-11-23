# 配送性能の計測

[English](README.md)

リポジトリルートで指定の Node.js を使って実行します。依存関係は `mise exec -- npm ci`、3 種類のブラウザエンジンは `mise exec -- npx playwright install chromium firefox webkit` でインストールします。

```sh
mise exec -- npm run demo:build
mise exec -- node benchmarks/delivery.ts server
mise exec -- node benchmarks/delivery.ts server-batch
mise exec -- node benchmarks/delivery.ts browser
mise exec -- node benchmarks/delivery.ts forwarder
```

他の処理が動いていないマシンで、各コマンドを個別に実行します。処理系と計測条件は JSON Lines で出力されます。
- **受信。** 合成した UBI 露出イベントを、HTTP 受信、ローカルのトークン検証器、スキーマ検証、SQLite WAL への永続コミットまで通します。v0.2 以降は受理した HTTP バッチを一つのトランザクションで確定します。`server` はイベントを単件で送信し、`server-batch` は最大 32 件をまとめて、イベントごとの受領を検証します。同時実行数ごとに 250 件でウォームアップし、2,000 件を 3 回計測します。レイテンシーは HTTP リクエスト単位です。イベント生成と受信は一つの Node.js プロセスでループバック接続します。
- **ブラウザ。** 表示されたカードを実際の露出監視に登録し、コレクター、IndexedDB キュー、HTTP 送信の経路を通します。ブラウザのルートで応答遅延を模擬し、イベントごとの受領結果を返します。`enqueueP95` は受け付けたイベントの監視コールバックから永続キューへの保存まで、`ackP95` は連続露出を開始してから HTTP で受領されるまでの時間です。露出の直後にクリックを発生させ、キューの空きと受領までの時間 `clickAckMs` を確認します。出力には POST の回数と実測した最大バッチ件数も含みます。
- **転送。** 固定時間でバッチの受領を返すローカルエンドポイントに対して Kinesis ワーカーを動かします。待機時の条件では、前のレコードを転送済みとして記録してから約 200 ms 後に次の 1 件を挿入します。負荷を掛ける条件では 2,000 件を処理し、転送先への最初のリクエストから最終バッチの受領確認までを計測します。

ブラウザでは受領遅延を制御したときのキューの挙動を計測します。受信側ではローカルの検証器とファイルベースの保存を使います。転送では、模擬応答を用いてポーリング、バッチ処理、受領の確認を計測します。

## v0.2.0 とのセッション初期化の比較

[v0.2.0 のリリース](https://github.com/tkhshtsh0917/liatris/releases/tag/v0.2.0)から `liatris-browser.tar.gz` と `SHA256SUMS` を取得します。一時ディレクトリでアーカイブを検証して展開し、リポジトリルートから比較を実行する際に、展開した `liatris-browser/` ディレクトリを指定します。

```sh
shasum -a 256 -c SHA256SUMS && tar -xzf liatris-browser.tar.gz
```

```sh
mise exec -- npm run demo:build
mise exec -- node benchmarks/delivery.ts browser-session /path/to/liatris-browser
```

はじめに、公開済み WASM と 11,575 件のセッション判定を照合します。次に Chromium、Firefox、WebKit で公開済み SDK と現在のブラウザ用ビルドを比較し、3 回の試行で実行順序を交互に入れ替えます。各試行では最初のイベントを IndexedDB に保存して HTTP の受領を待ち、その後、40 件または 250 件の連続露出を計測します。模擬 API は 40 件の場合は追加遅延なし、250 件の場合は 40 ms 後に応答し、両版で同じ条件を使います。追加の 0 ms または 40 ms の待ち時間は旧セッションモジュールの取得だけに適用します。連続露出時のレイテンシーをまとめる際は、SDK と条件ごとに各試行の `ackP95` の中央値を取ります。
