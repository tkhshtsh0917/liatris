# Liatris

[English](README.md)

Rust と WebAssembly を使う、設定可能な User Behavior Insights 向けブラウザイベント収集ツールです。

Liatris は Rust/WASM のセッション判定と TypeScript のコレクターを使います。TOML、YAML、JSON でイベント名と項目を設定し、イベントが発生した時点でアプリケーションからコレクターを呼び出します。

## ローカルデモを実行する

[rust-toolchain.toml](rust-toolchain.toml) の Rust ツールチェーンと [mise.toml](mise.toml) の Node.js をインストールします。

```sh
npm ci
mise run check
npm run demo
```

[ローカルデモ](http://127.0.0.1:4173/)を開き、収集を許可し、サンプルの商品一覧を検索して 2 件目の結果をクリックします。受信した検索、露出、クリックがターミナルに表示されます。これらはクエリ ID とセッション ID を共有します。露出とクリックには表示結果セット ID も付き、クリックの順位は 2 になります。**no results** の例では、クリックを伴わないクエリを収集します。

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
- [ロードマップ](docs/ja/roadmap.md) は実装と検証のマイルストーンを示します。
- [設計](docs/ja/design.md) では、UBI のスキーマモード、セッションポリシー、計画中の配送アダプターを説明します。
- [イベント契約](docs/ja/event-contracts.md) では、EC・求人サイトのイベント定義例を示します。

収集プロファイルだけをコンパイルするには `mkdir -p dist && npm run profile -- examples/shop.toml dist/shop.profile.json` を実行します。コンパイラは正規化済み JSON を書き込み、SHA-256 を表示します。

デモと参考受信実装はローカルで動作します。タグ配布、耐久性のあるキュー、Kinesis・gRPC アダプターは計画段階です。
