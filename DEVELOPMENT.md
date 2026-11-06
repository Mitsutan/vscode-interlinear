# 開発ガイド

## 試す

1. リポジトリのルートを VS Code で開く。
2. 実行とデバッグから **「拡張機能を起動 (Interlinear)」**（F5）を選ぶ。
3. 拡張がビルドされ、`test/fixtures` を開いた開発用ウィンドウが立ち上がる。

翻訳サーバーの用意の仕方は2通りある。

- **自動管理（既定）**: 初回にセットアップを実行する。
- **外部サーバー**: 自分で起動した llama-server（起動方法は [README](README.md#自分で起動したサーバーを使う)）を使い、`interlinear.server.mode` を `external` にする。

## コマンド

```bash
npm install
npm run typecheck          # 型チェック
npm test                   # 単体テスト（Node の型ストリップで .ts を直接実行。Node 23.6 以上）
npm run build              # dist/extension.cjs と dist/wasm/ を生成
npm run package            # 配布用にビルドして VSIX を作る（interlinear-<版>.vsix）
npm run check:manifest     # 自動管理でダウンロードするファイルの URL とサイズを確かめる
```

### 統合テスト

VS Code（stable）をダウンロードし、モックサーバーを相手に、ホバー・先読み・行末表示・自動管理などを確かめる。

```bash
npm run test:integration                 # デスクトップ環境
xvfb-run -a npm run test:integration     # ディスプレイのない Linux（下の準備が必要）
```

環境変数を指定すると、追加の確認をする。

| 環境変数 | 内容 |
|---|---|
| `INTERLINEAR_E2E_ENDPOINT=http://127.0.0.1:18080` | 起動中の llama-server で、ホバーに実際の訳文が出るか |
| `INTERLINEAR_REAL_LLAMA_SERVER=<llama-server のパス>` と `INTERLINEAR_REAL_MODEL=<GGUF のパス>` | 自動管理モードで、本物の llama-server を拡張が起動して訳せるか |
| `INTERLINEAR_SCREENSHOT_DIR=<ディレクトリ>` | `INTERLINEAR_E2E_ENDPOINT` と一緒に使う。行末表示の状態で止まり、外部から撮影されるのを待つ |
| `INTERLINEAR_EXTENSION_PATH=<展開した VSIX の extension/>` | ソースではなく、VSIX の中身を読み込んでテストする |

単体テストも、`INTERLINEAR_REAL_LLAMA_SERVER` と `INTERLINEAR_REAL_MODEL` を指定すると、本物の llama-server で起動して訳せるかを確かめる。自動管理でセットアップ済みなら、拡張の保存領域（`globalStorage/mitsutan.interlinear/` の下の `llama.cpp/` と `models/`）にあるものを指定できる。

### Dev Container で統合テストを動かす準備

```bash
sudo apt-get install -y --no-install-recommends xvfb xauth libnss3 libatk-bridge2.0-0t64 libgtk-3-0t64 \
  libgbm1 libasound2t64 libxkbfile1 libsecret-1-0 libxss1
# スクリーンショットを撮る場合
sudo apt-get install -y --no-install-recommends imagemagick fonts-noto-cjk
```

## VSIX の確認

```bash
npm run package
rm -rf /tmp/vsix && mkdir /tmp/vsix && python3 -m zipfile -e interlinear-*.vsix /tmp/vsix
node esbuild.mjs --tests
INTERLINEAR_EXTENSION_PATH=/tmp/vsix/extension xvfb-run -a node test/integration/run.ts
```

## 構成

| パス | 内容 |
|---|---|
| `src/core/` | VS Code に依存しない部分。PFML3 プロンプト、llama-server クライアント、tree-sitter による抽出、正規化、ホバーの Markdown の分割、行末表示の配置 |
| `src/translation/` | キャッシュ（LRU と永続化）、優先度付きキュー、翻訳サービス |
| `src/managed/` | 自動管理モード。ダウンロードするファイルの固定（manifest）、検証付きダウンロード、配置、llama-server の起動・停止 |
| `src/editor/` | HoverProvider（コメント用・ドキュメント用）、先読み、行末表示、ステータスバー、セットアップの流れ |
| `src/extension.ts` | エントリポイント（設定・コマンドの登録） |
| `test/unit/` | 単体テスト（`node --test`） |
| `test/integration/` | 統合テスト（`@vscode/test-electron`） |
| `test/fixtures/` | F5 で開くサンプルと、スクリーンショット用のファイル（型チェックの対象外） |
| `scripts/check-manifest.ts` | manifest の URL とサイズの確認 |

## 採用しなかった表示方式

拡張の API では、行と行の間に複数行の領域を差し込めない（エディタ内部の view zone は公開されていない）。そのため、訳文はホバーと行末表示（1行の装飾）で出している。

| 方式 | 採用しなかった理由 |
|---|---|
| Comments API（行間に展開するウィジェット） | 複数行の訳文を行間に出せるが、レビュー用の見た目（返信欄など）が残り、Comments パネルにも並ぶ。複数行のブロックは、ホバーと `all` の行末表示で読める |
| 訳文入りの読み取り専用の仮想ドキュメントを横に並べる | 元のコードと行がずれるうえ、編集中の内容と同期させる仕組みが要る |
| CSS を注入して原文を隠し、訳文を重ねる | 非公式の方法で、VS Code の更新で壊れやすい |

## llama.cpp やモデルを更新するとき

1. `src/managed/manifest.ts` を書き換える。
   - llama.cpp: ビルド番号と、各プラットフォームのファイル名・サイズ・SHA-256（GitHub Release の digest）。
   - Linux 版の `minGlibc`: 展開したファイルを `readelf -V --wide` で調べ、`GLIBC_` の最大のバージョンにする（arm64 と x64 でビルド環境が違う）。
   - モデル: Hugging Face のコミット・サイズ・SHA-256（LFS のハッシュ）。
2. `npm run check:manifest` で、URL とサイズを確かめる。
3. ライセンスの条件が変わったら、`LICENSE_CONSENT_VERSION` を上げる。利用者に同意を取り直すため。
