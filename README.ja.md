# Liatris

[English](README.md)

Rust と WebAssembly を使う、設定可能な User Behavior Insights 向けブラウザイベント収集ツールです。

Liatris は Rust/WASM のセッション判定と TypeScript のコレクターを使います。TOML、YAML、JSON で収集するイベント名と項目を設定します。アプリケーションはイベントが発生した時点でコレクターを呼び、結果 ID や表示順位などの文脈を渡します。

既存サービスに組み込む場合は、[導入ガイド](docs/ja/integration.md)に沿って、プロファイル、検索画面、受信 API をつなぎます。

## ローカルデモを実行する

[rust-toolchain.toml](rust-toolchain.toml) の Rust ツールチェーンと [mise.toml](mise.toml) の Node.js をインストールします。

```sh
mise exec -- npm ci
mise run check
mise exec -- npm run demo
```

[ローカルデモ](http://127.0.0.1:4173/)を開き、収集を許可し、サンプルの商品一覧を検索して 2 件目の結果をクリックします。ターミナルには受信したイベントの種別が表示されます。ローカルのリクエストを確認すると、検索、露出、クリックがクエリ ID とセッション ID を共有していることが分かります。露出とクリックには表示結果セット ID も付き、クリックの順位は 2 になります。**no results** では `result_count: 0` の `results_shown` を記録します。`search_submitted`、`results_shown`、初回クリックを確認すると、結果件数、順位付けの版、結果表示からクリックまでの時間が分かります。

## 計測設定を変更する

```toml
[impressions]
minVisiblePercent = 70

[session]
inactivityMinutes = 15
```

カードの表示面積は既定で 50%、セッションは無操作から既定で 30 分です。セクションを省略すると既定値を使います。露出を計測するには、アプリケーションから結果カードを登録します。[計測の契約](docs/ja/event-contracts.md#カードの露出)。

## 導入方法を見る

- [収集プロファイル](examples/shop.toml) は許可する項目を宣言し、サンプルデモの検索語収集を明示的に有効にします。[YAML の例](examples/shop.yaml)。
- [ブラウザでの組み込み例](demo/browser.ts) では、同意、検索とクリックの収集、HTTP/JSON 配送を確認できます。
- [永続配送](docs/ja/delivery.md) では、ローカルへの保存、再送、ストリーミング先への転送契約とアダプターの例を説明します。
- [セキュリティとプライバシー](docs/ja/security.md) では、Cookie、同意、認証、公開時の制御を説明します。
- [ロードマップ](docs/ja/roadmap.md) は実装と検証のマイルストーンを示します。
- [設計](docs/ja/design.md) では、UBI のスキーマモード、セッションポリシー、配送方式を説明します。
- [イベント契約](docs/ja/event-contracts.md) では、EC・求人サイトのイベント定義例を示します。

収集プロファイルだけをコンパイルするには `mkdir -p dist && npm run profile -- examples/shop.toml dist/shop.profile.json` を実行します。コンパイラは正規化済み JSON を書き込み、SHA-256 を表示します。

デモは IndexedDB キューと SQLite のリファレンス受信実装を使います。受領済みのイベントは、サーバー側のアダプターで導入先のストリーミング基盤へ転送できます。動作する接続例として Amazon Kinesis Data Streams 用のアダプターを同梱しています。[導入ガイド](docs/ja/integration.md#2-ブラウザ-sdk-を配置しプロファイルをコンパイルする)では、[GitHub Releases](https://github.com/tkhshtsh0917/liatris/releases) のブラウザ SDK を検証して組み込む手順を説明します。
