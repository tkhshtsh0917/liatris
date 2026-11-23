# イベント検証・整形の実験

[English](README.md)

同じ Rust 製のプロファイル検証ルールを、ブラウザの WASM とネイティブの Node-API アドオンで動かす実験です。宣言済みのイベント入力とクエリ入力を、コレクターが使うのと同じ JSON 互換の項目に整形します。通常の SDK と受信側にこのモジュールへの依存はありません。

TypeScript のアダプターはエンコード前に、JavaScript のオブジェクトが通常のデータプロパティを持つことを確認します。孤立した UTF-16 サロゲートや、明示的に `undefined` を渡した項目など、JSON アダプターで扱えない入力は既存の実装に渡します。リファレンス受信側は従来どおりリクエストの認証、エンベロープの検査、および固定した UBI スキーマの検証を行います。

## 検証と計測

固定版の Node.js と Rust、およびネイティブリンカーがある環境で、リポジトリのルートから実行します。プロジェクトの npm 依存関係と Playwright のブラウザを先にインストールします。

```sh
mise run event-core:check
mise exec -- npm run demo:build
mise exec -- node benchmarks/delivery.ts event-projection
mise exec -- node benchmarks/delivery.ts browser
mise exec -- node benchmarks/delivery.ts browser-rust
mise exec -- node benchmarks/delivery.ts server-batch
mise exec -- node benchmarks/delivery.ts server-batch-native
```

検証・整形のベンチマークには、ホストでの入力の複製、JSON シリアライズ、データ受け渡し、整形した結果の取り出しが含まれます。1回に32件渡す条件も計測します。ブラウザと受信側の試験では通常の実行経路を使い、イベントとクエリの検証・整形関数だけを計測用のモジュールに差し替えます。この経路では現行のコレクターと受信側が使う単件 API を計測します。

ブラウザ用の成果物は `session.wasm` とは別に生成します。ネイティブアドオンは実行ホスト用にビルドします。Rust のビルド成果物は実験ディレクトリ内の `target/` に出力します。[配送ベンチマークの条件](../../benchmarks/README.md)
