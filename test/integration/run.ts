/**
 * 統合テストの起動スクリプト。VS Code をダウンロードして（.vscode-test/ にキャッシュ）、
 * 開発中の拡張を読み込んだ状態で dist-test/suite.cjs を実行する。
 *
 *   npm run test:integration                # デスクトップ環境
 *   xvfb-run -a npm run test:integration    # ディスプレイのない Linux（Dev Container など）
 *
 * VSCODE_TEST_VERSION で VS Code のバージョンを指定できる（既定: stable）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';

// VS Code の統合ターミナルや Extension Host から実行すると、これらの環境変数が引き継がれる。
// ELECTRON_RUN_AS_NODE があると VS Code が Node として起動して失敗し、
// VSCODE_IPC_HOOK_CLI などがあると、テスト用の VS Code が実行中のウィンドウに接続しようとする。
for (const name of Object.keys(process.env)) {
  if (name === 'ELECTRON_RUN_AS_NODE' || name.startsWith('VSCODE_')) delete process.env[name];
}

const root = path.resolve(import.meta.dirname, '../..');
const userDataDir = await mkdtemp(path.join(tmpdir(), 'interlinear-user-'));
const extensionsDir = await mkdtemp(path.join(tmpdir(), 'interlinear-ext-'));
// スクリーンショットで編集領域を広く写すため、最大化してサイドパネルを隠す（テストの結果には影響しない）
await mkdir(path.join(userDataDir, 'User'), { recursive: true });
await writeFile(
  path.join(userDataDir, 'User', 'settings.json'),
  JSON.stringify({
    'window.newWindowDimensions': 'maximized',
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'workbench.startupEditor': 'none',
    // セットアップのダイアログを VS Code の中に描画させ、仮想ディスプレイ上で撮影・キー操作できるようにする
    'window.dialogStyle': 'custom',
    // Copilot の案内や Chat を出さない。スクリーンショットに写り込み、案内のダイアログはキー入力も奪う
    'chat.disableAIFeatures': true,
    // テスト用の VS Code は英語表示で、出力言語の既定値が en になる。フィクスチャは英語のコメントなので、訳す対象にするため ja にする
    'interlinear.targetLanguage': 'ja',
  }),
);

try {
  await runTests({
    version: process.env.VSCODE_TEST_VERSION ?? 'stable',
    // INTERLINEAR_EXTENSION_PATH を指定すると、ソースではなく展開した VSIX の中身を読み込む（配布物だけで動くかを確かめる）
    extensionDevelopmentPath: process.env.INTERLINEAR_EXTENSION_PATH ?? root,
    extensionTestsPath: path.join(root, 'dist-test', 'suite.cjs'),
    // 実モデルでの確認: INTERLINEAR_E2E_ENDPOINT=http://127.0.0.1:18080 npm run test:integration
    extensionTestsEnv: Object.fromEntries(
      [
        'INTERLINEAR_E2E_ENDPOINT',
        'INTERLINEAR_SCREENSHOT_DIR',
        'INTERLINEAR_SCREENSHOT_THEMES',
        'INTERLINEAR_SCREENSHOT_LANGS',
        'INTERLINEAR_REAL_LLAMA_SERVER',
        'INTERLINEAR_REAL_MODEL',
      ].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])),
    ),
    launchArgs: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
    ],
  });
} finally {
  await rm(userDataDir, { recursive: true, force: true });
  await rm(extensionsDir, { recursive: true, force: true });
}
