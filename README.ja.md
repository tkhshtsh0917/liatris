# Liatris

[English](README.md)

設定可能な User Behavior Insights 向けブラウザイベント収集ツールです。

Liatris はセッション管理を内蔵した TypeScript のコレクターです。TOML、YAML、JSON でイベント名と項目を設定し、各イベントが発生した時点でアプリケーションからコレクターを呼びます。収集内容はプロファイルで宣言します。発生時点や、結果 ID や表示順位などの文脈はアプリケーションが渡します。

既存サービスに組み込む場合は、[導入ガイド](docs/ja/integration.md)に沿って、プロファイル、検索画面、受信 API をつなぎます。

## ローカルデモを実行する

[mise.toml](mise.toml) で指定した Node.js をインストールして、デモを起動します。

```sh
mise install
mise exec -- npm ci
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

収集プロファイルだけをコンパイルするには `mkdir -p dist && mise exec -- npm run profile -- examples/shop.toml dist/shop.profile.json` を実行します。コンパイラは正規化済み JSON を書き込み、SHA-256 を表示します。

デモは IndexedDB キューと SQLite のリファレンス受信実装を使います。受領済みのイベントは、サーバー側のアダプターで導入先のストリーミング基盤へ転送できます。動作する接続例として Amazon Kinesis Data Streams 用のアダプターを同梱しています。[導入ガイド](docs/ja/integration.md#2-ブラウザ-sdk-を配置しプロファイルをコンパイルする)では、[GitHub Releases](https://github.com/tkhshtsh0917/liatris/releases) のブラウザ SDK を検証して組み込む手順を説明します。

## 変更を検証する

依存関係をインストールしてから、リポジトリルートで次を実行します。

```sh
mise run check
mise exec -- npx playwright install chromium firefox webkit
mise exec -- npm run test:browser
mise exec -- npm run sdk:build
mise exec -- npm run test:sdk
```

整形、lint、型、単体テスト、ブラウザでの配送、展開した SDK の利用を確認します。任意のストリーミング接続例には Docker Compose を使った往復テストがあります。[配送の検証](docs/ja/delivery.md#検証)

## ライセンス

Liatris は [MIT ライセンス](LICENSE)で配布します。リポジトリに収録している UBI スキーマの複製には [Apache-2.0](schema/upstream/ubi-1.3.0/LICENSE) が適用されます。
