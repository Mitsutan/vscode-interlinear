/**
 * VS Code の Extension Host 内で動く統合テスト（esbuild で dist-test/suite.cjs にバンドルして使う）。
 * llama-server の代わりに、"[訳]" を付けて返すモックサーバーを立てる。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.ts';

const EXTENSION_ID = 'mitsutan.interlinear';

// ---------------------------------------------------------------------------
// モックサーバー

interface MockServer {
  url: string;
  /** /completion で受け取った原文 */
  requests: string[];
  /** /completion で受け取ったプロンプト全体 */
  prompts: string[];
  close(): Promise<void>;
}

const INPUT = /<\|plamo:tag\|>input(?:<\|plamo:key\|>lang<\|plamo:val\|>[\w-]+)?<\|plamo:msg\|>([\s\S]*?)<\|plamo:tag\|>output/;

async function startMockServer(): Promise<MockServer> {
  const requests: string[] = [];
  const prompts: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (body: unknown) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      if (req.url === '/health') return send({ status: 'ok' });
      if (req.url === '/props') return send({ model_path: '/models/mock-model.gguf' });
      if (req.url === '/completion' && req.method === 'POST') {
        const { prompt } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { prompt: string };
        const text = INPUT.exec(prompt)?.[1] ?? '';
        requests.push(text);
        prompts.push(prompt);
        return send({ content: `[訳]${text}`, stop_type: 'eos', timings: { prompt_n: 1, prompt_ms: 1, predicted_n: 1, predicted_ms: 1, predicted_per_second: 1 } });
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    prompts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// ヘルパー

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, cond: () => boolean, timeoutMs = 10_000, poll?: () => Promise<void>): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await poll?.();
    if (cond()) return;
    if (Date.now() > until) throw new Error(`timeout: ${what}`);
    await sleep(poll ? 500 : 50);
  }
}

async function writeTempTs(content: string): Promise<vscode.Uri> {
  const dir = await mkdtemp(path.join(tmpdir(), 'interlinear-doc-'));
  const file = path.join(dir, 'math.ts');
  await writeFile(file, content);
  return vscode.Uri.file(file);
}

async function hoverText(doc: vscode.TextDocument, line: number, character: number): Promise<string> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    doc.uri,
    new vscode.Position(line, character),
  );
  return hovers
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === 'string' ? c : c.value))
    .join('\n---\n');
}

async function openTs(content: string): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument({ language: 'typescript', content });
  await vscode.window.showTextDocument(doc);
  return doc;
}

const config = () => vscode.workspace.getConfiguration('interlinear');
const setConfig = (key: string, value: unknown) => config().update(key, value, vscode.ConfigurationTarget.Global);

/** 開いているエディターをすべて閉じる */
async function closeAllEditors(): Promise<void> {
  const count = () => vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0);
  for (let n = count(); n > 0; ) {
    // 単に閉じないのは、未保存の無題のドキュメントで保存を確かめるダイアログが出て、テストからは答えられないため
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    const left = count();
    if (left >= n) throw new Error(`エディターを閉じられない（残り ${left}）`);
    n = left;
  }
}

/** カーソルを置いてホバーを開く（撮影用。内容の確認は hoverText で行う） */
async function showHoverAt(editor: vscode.TextEditor, pos: vscode.Position): Promise<void> {
  editor.selection = new vscode.Selection(pos, pos);
  await vscode.commands.executeCommand('editor.action.showHover');
}

// ---------------------------------------------------------------------------

const FIXTURE = [
  '// eslint-disable-next-line no-console', //       0
  'console.log(1);', //                              1
  '', //                                             2
  '/**', //                                          3
  ' * Parses the configuration file.', //            4
  ' *', //                                           5
  ' * @param path - Absolute path to the file.', //  6
  ' */', //                                          7
  'export function parse(path: string) {', //        8
  '  return path; // return as is', //               9
  '}', //                                            10
  '', //                                             11
  '// 日本語のコメント', //                           12
  'const x = 1;', //                                 13
].join('\n');

/** llama-server の代わりに起動する偽サーバー（引数の --port で待ち受け、訳文にプロセス ID を入れて返す） */
const FAKE_LLAMA_SERVER = `#!/usr/bin/env node
const http = require('node:http');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const model = args[args.indexOf('-m') + 1];
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok' }));
    if (req.url === '/props') return res.end(JSON.stringify({ model_path: model }));
    if (req.url === '/completion') return res.end(JSON.stringify({ content: '[自動管理:' + process.pid + ']', stop_type: 'eos' }));
    res.statusCode = 404; res.end('{}');
  });
}).listen(port, '127.0.0.1');
`;

async function writeFakeServer(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'interlinear-fake-'));
  const file = path.join(dir, 'llama-server');
  await writeFile(file, FAKE_LLAMA_SERVER);
  await chmod(file, 0o755);
  return file;
}

const DOC_FIXTURE = [
  '/**', //                                                      0
  ' * Adds two numbers and returns the sum.', //                  1
  ' *', //                                                       2
  ' * @param a - The first number.', //                          3
  ' */', //                                                      4
  'export function add(a: number, b: number): number {', //      5
  '  return a + b;', //                                          6
  '}', //                                                       7
  'add(1, 2);', //                                               8
].join('\n');

export async function run(): Promise<void> {
  const mock = await startMockServer();
  await setConfig('endpoint', mock.url);
  await setConfig('prefetch', false); // 前半はホバーだけでリクエスト数を確かめる
  await setConfig('inlineTranslation', 'off'); // 行末表示も画面内を訳すので、専用のテストでだけ有効にする

  const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
  assert.ok(ext, 'extension not found');
  const api = await ext.activate();
  const doc = await openTs(FIXTURE);

  const tests: Array<[string, () => Promise<void>]> = [
    [
      'JSDoc にホバーすると、説明文とタグの説明だけが訳される',
      async () => {
        const text = await hoverText(doc, 4, 6);
        assert.match(text, /\[訳\]Parses the configuration file\./);
        assert.match(text, /@param path - \[訳\]Absolute path to the file\./);
        assert.match(text, /mock-model/);
        assert.deepEqual(mock.requests, ['Parses the configuration file.', 'Absolute path to the file.']);
      },
    ],
    [
      '2回目はキャッシュから返し、サーバーに問い合わせない',
      async () => {
        const text = await hoverText(doc, 6, 10);
        assert.match(text, /\[訳\]Parses/);
        assert.equal(mock.requests.length, 2);
      },
    ],
    [
      '行末コメントは、コメント部分にホバーしたときだけ訳す',
      async () => {
        const line = doc.lineAt(9).text;
        assert.match(await hoverText(doc, 9, line.indexOf('//') + 4), /\[訳\]return as is/);
        assert.doesNotMatch(await hoverText(doc, 9, 4), /\[訳\]/);
      },
    ],
    [
      'ディレクティブと、すでに日本語のコメントは訳さない',
      async () => {
        assert.doesNotMatch(await hoverText(doc, 0, 5), /\[訳\]/);
        assert.doesNotMatch(await hoverText(doc, 12, 5), /\[訳\]/);
      },
    ],
    [
      '無効にするとホバーを出さない',
      async () => {
        await setConfig('enabled', false);
        try {
          assert.doesNotMatch(await hoverText(doc, 4, 6), /\[訳\]/);
        } finally {
          await setConfig('enabled', true);
        }
        assert.match(await hoverText(doc, 4, 6), /\[訳\]/);
      },
    ],
    [
      '先読み: 表示中のコメントがホバーなしで翻訳される',
      async () => {
        const before = mock.requests.length;
        await setConfig('prefetch', true);
        await openTs(['// First visible comment.', 'a();', '// Second visible comment.', 'b();'].join('\n'));
        await waitFor('prefetch', () =>
          ['First visible comment.', 'Second visible comment.'].every((t) => mock.requests.includes(t)),
        );
        assert.equal(mock.requests.length, before + 2);
        await setConfig('prefetch', false);
      },
    ],
    [
      '行末表示: short は行コメントと1行のコメント、all は JSDoc にも出し、コマンドで切り替えられる',
      async () => {
        const inlineDoc = await openTs(
          [
            '// Load the configuration.', //            0
            'const a = 1; // trailing note here', //     1
            '// First paragraph that is', //            2
            '// wrapped over two lines.', //            3
            'f();', //                                  4
            '/**', //                                   5
            ' * Summary of the function.', //           6
            ' * @param x - The value.', //              7
            ' */', //                                   8
            'function g(x) {}', //                      9
          ].join('\n'),
        );
        const shown = () => Object.fromEntries(api.inlineLines(inlineDoc.uri).map((l) => [l.line, l.text]));

        await setConfig('inlineTranslation', 'short');
        await waitFor('short', () => Object.keys(shown()).length === 3);
        assert.deepEqual(shown(), {
          0: '[訳]Load the configuration.',
          1: '[訳]trailing note here',
          2: '[訳]First paragraph that is wrapped over two lines.',
        });

        await setConfig('inlineTranslation', 'all');
        await waitFor('all', () => shown()[7] !== undefined);
        assert.equal(shown()[6], '[訳]Summary of the function.');
        assert.equal(shown()[7], '[訳]The value.');

        await vscode.commands.executeCommand('interlinear.toggleInline');
        await waitFor('toggle off', () => Object.keys(shown()).length === 0);
        assert.equal(config().get('inlineTranslation'), 'off');
        await vscode.commands.executeCommand('interlinear.toggleInline');
        await waitFor('toggle on', () => shown()[7] !== undefined);
        assert.equal(config().get('inlineTranslation'), 'all', '直前の範囲に戻る');

        await setConfig('inlineTranslation', 'off');
      },
    ],
    [
      'キャッシュ削除コマンドでキャッシュが空になる',
      async () => {
        assert.ok(api.service.cache.size > 0);
        await vscode.commands.executeCommand('interlinear.clearCache');
        assert.equal(api.service.cache.size, 0);
      },
    ],
    [
      'ドキュメント: TypeScript のホバーに、説明文とタグの説明の訳を追加する（シグネチャは重複させない）',
      async () => {
        const docUri = await writeTempTs(DOC_FIXTURE);
        const tsDoc = await vscode.workspace.openTextDocument(docUri);
        await vscode.window.showTextDocument(tsDoc);
        const before = mock.prompts.length;
        // TypeScript のサーバーが起動するまで待つ
        let text = '';
        await waitFor(
          'TypeScript hover',
          () => /\[訳\]Adds two numbers/.test(text),
          60_000,
          async () => {
            text = await hoverText(tsDoc, 8, 1);
          },
        );
        assert.match(text, /\[訳\]Adds two numbers and returns the sum\./);
        assert.match(text, /\*@param\* `a` \u2014 \[訳\]The first number\./);
        assert.equal(text.match(/function add\(/g)?.length, 1, 'シグネチャは元のホバーにだけ出る');
        const docPrompts = mock.prompts.slice(before);
        assert.ok(docPrompts.length >= 2);
        assert.ok(
          docPrompts.every((p) => p.includes('Documentation shown on hover') && p.includes('Symbol: function add(a: number, b: number): number')),
          docPrompts.join('\n'),
        );

        // 2回目はキャッシュから返す
        const count = mock.requests.length;
        assert.match(await hoverText(tsDoc, 8, 1), /\[訳\]Adds two numbers/);
        assert.equal(mock.requests.length, count);

        // コメントの中ではコメントの翻訳だけを出し、ドキュメントの翻訳を重ねない
        const inComment = await hoverText(tsDoc, 1, 5);
        assert.equal(inComment.match(/\[訳\]Adds two numbers/g)?.length, 1, inComment);

        // 設定で無効にできる
        await setConfig('translateDocumentation', false);
        try {
          const off = await hoverText(tsDoc, 8, 1);
          assert.match(off, /Adds two numbers/);
          assert.doesNotMatch(off, /\[訳\]/);
        } finally {
          await setConfig('translateDocumentation', true);
        }
      },
    ],
    [
      '自動管理: 未セットアップなら、ホバーに理由とセットアップへのリンクを出す',
      async () => {
        await setConfig('server.mode', 'managed');
        try {
          await waitFor('needsSetup', () => api.server.needsSetup);
          const d = await openTs('// Needs setup first.\nf();');
          const text = await hoverText(d, 0, 5);
          assert.match(text, /セットアップを実行してください/);
          assert.match(text, /command:interlinear\.setup/);
        } finally {
          await setConfig('server.mode', undefined);
        }
        await waitFor('external again', () => !api.server.needsSetup);
      },
    ],
    [
      '自動管理: 指定した llama-server を空いているポートで起動して翻訳し、再起動コマンドで起動し直す',
      async () => {
        const fake = await writeFakeServer();
        await setConfig('server.llamaServerPath', fake);
        await setConfig('server.modelPath', '/models/fake-managed.gguf');
        await setConfig('server.mode', 'managed');
        try {
          await waitFor('managed ready', () => !api.server.needsSetup);
          const d = await openTs('// Managed server comment.\nf();');
          const first = await hoverText(d, 0, 5);
          assert.match(first, /\[自動管理:\d+\]/);
          assert.match(first, /fake-managed/);
          assert.deepEqual(api.service.serverState, { status: 'ok', model: 'fake-managed' });
          const pid = /\[自動管理:(\d+)\]/.exec(first)?.[1];

          await vscode.commands.executeCommand('interlinear.restartServer');
          assert.equal(api.service.serverState.status, 'ok');
          // 別のコメントを訳させて、新しいプロセスが応答していることを確かめる
          const d2 = await openTs('// Another managed comment.\nf();');
          const second = await hoverText(d2, 0, 5);
          const pid2 = /\[自動管理:(\d+)\]/.exec(second)?.[1];
          assert.ok(pid && pid2 && pid !== pid2, `${pid} → ${pid2}`);
        } finally {
          await setConfig('server.mode', undefined);
          await setConfig('server.llamaServerPath', undefined);
          await setConfig('server.modelPath', undefined);
        }
      },
    ],
    [
      '接続先で別のアプリが動いているときは、llama-server ではないと伝える',
      async () => {
        const other = http.createServer((_req, res) => {
          res.setHeader('content-type', 'text/html');
          res.end('<html>another project</html>');
        });
        await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
        try {
          await setConfig('endpoint', `http://127.0.0.1:${(other.address() as AddressInfo).port}`);
          const text = await hoverText(doc, 4, 6);
          assert.match(text, /llama-server ではありません/);
        } finally {
          await setConfig('endpoint', mock.url);
          await new Promise<void>((resolve) => other.close(() => resolve()));
        }
      },
    ],
    [
      'サーバーに接続できないときは、ホバーに理由を出す',
      async () => {
        await mock.close();
        const text = await hoverText(doc, 4, 6);
        assert.match(text, /翻訳できませんでした/);
        assert.match(text, /接続できません/);
        assert.equal(api.service.serverState.status, 'down');
      },
    ],
  ];

  // 本物の llama-server を相手にした確認（INTERLINEAR_E2E_ENDPOINT を指定したときだけ）
  const e2eEndpoint = process.env.INTERLINEAR_E2E_ENDPOINT;
  if (e2eEndpoint) {
    tests.push([
      `E2E: ${e2eEndpoint} の実モデルでホバーに日本語訳が出る`,
      async () => {
        await setConfig('endpoint', e2eEndpoint);
        const e2eDoc = await openTs(
          [
            '/**',
            ' * Returns the number of listeners listening for the event named `eventName`.',
            ' *',
            ' * @param eventName - The name of the event being listened for.',
            ' */',
            'declare function listenerCount(eventName: string): number;',
          ].join('\n'),
        );
        const started = Date.now();
        const text = await hoverText(e2eDoc, 1, 6);
        const elapsed = Date.now() - started;
        console.log(`    ${elapsed} ms\n${text.replace(/^/gm, '    | ')}`);
        assert.match(text, /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u);
        assert.match(text, /`eventName`/);
        assert.match(text, /@param eventName - /);
        assert.equal(api.service.serverState.status, 'ok');
      },
    ]);
    tests.push([
      `E2E: ${e2eEndpoint} の実モデルで、TypeScript 標準ライブラリのドキュメント（JSON.stringify）が訳される`,
      async () => {
        await setConfig('endpoint', e2eEndpoint);
        const uri = await writeTempTs('const s = JSON.stringify({ a: 1 }, null, 2);\n');
        const e2eDoc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(e2eDoc);
        const col = e2eDoc.lineAt(0).text.indexOf('stringify') + 2;
        let text = '';
        const started = Date.now();
        await waitFor(
          'translated documentation',
          () => /ローカル翻訳/.test(text),
          120_000,
          async () => {
            text = await hoverText(e2eDoc, 0, col);
          },
        );
        console.log(`    ${Date.now() - started} ms（TypeScript の起動待ちを含む）\n${text.replace(/^/gm, '    | ')}`);
        const translated = text.slice(text.lastIndexOf('```') + 3);
        assert.match(translated, /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u);
        assert.match(translated, /\*@param\* `value` — /);
        // 2回目はキャッシュから即座に返る
        const t2 = Date.now();
        await hoverText(e2eDoc, 0, col);
        console.log(`    2回目: ${Date.now() - t2} ms`);
      },
    ]);
  }

  const realServer = process.env.INTERLINEAR_REAL_LLAMA_SERVER;
  const realModel = process.env.INTERLINEAR_REAL_MODEL;
  if (realServer && realModel) {
    tests.push([
      `実モデル（自動管理）: ${path.basename(realModel)} を拡張が起動して、日本語に訳す`,
      async () => {
        await setConfig('server.llamaServerPath', realServer);
        await setConfig('server.modelPath', realModel);
        await setConfig('server.mode', 'managed');
        try {
          const d = await openTs('// Returns the number of listeners for the event.\nf();');
          const started = Date.now();
          const text = await hoverText(d, 0, 5);
          console.log(`    ${Date.now() - started} ms（モデルの読み込みを含む）\n${text.replace(/^/gm, '    | ')}`);
          assert.match(text, /[\p{Script=Hiragana}\p{Script=Han}]/u);
        } finally {
          await setConfig('server.mode', undefined);
          await setConfig('server.llamaServerPath', undefined);
          await setConfig('server.modelPath', undefined);
        }
      },
    ]);
  }

  // 実モデルで訳した状態を表示し、外から撮影されるのを待つ（INTERLINEAR_SCREENSHOT_DIR を指定したときだけ）。
  // 撮影する側（scripts/screenshots.sh）は、ready-<名前> ができたら画面を撮って <名前>.png を置く
  const shotDir = process.env.INTERLINEAR_SCREENSHOT_DIR;
  if (e2eEndpoint && shotDir) {
    const shoot = async (name: string) => {
      await sleep(1000);
      await writeFile(path.join(shotDir, `ready-${name}`), '');
      await waitFor(`screenshot (${name})`, () => existsSync(path.join(shotDir, `${name}.png`)), 30_000);
    };
    // 拡張の場所（ext.extensionPath）から探さないのは、INTERLINEAR_EXTENSION_PATH で VSIX の中身を読み込むと、そこに test/ がないため
    const fixture = (name: string) => vscode.Uri.file(path.resolve(__dirname, '..', 'test', 'fixtures', name));
    const showInline = async (uri: vscode.Uri, mode: 'short' | 'all') => {
      await setConfig('inlineTranslation', mode);
      await sleep(500);
      await waitFor(`translations (${mode})`, () => api.service.queue.pending === 0 && api.inlineLines(uri).length > 0, 120_000);
    };

    tests.push([
      'スクリーンショット: test/fixtures/edge-cases.ts の行末表示（見た目の確認用）',
      async () => {
        await setConfig('endpoint', e2eEndpoint);
        const sample = fixture('edge-cases.ts');
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sample));
        for (const mode of ['short', 'all'] as const) {
          await showInline(sample, mode);
          await shoot(`inline-${mode}`);
        }
        await setConfig('inlineTranslation', 'off');
      },
    ]);

    tests.push([
      'スクリーンショット: test/fixtures/showcase.ts の行末表示とホバー（README 用）',
      async () => {
        await setConfig('endpoint', e2eEndpoint);
        // 前のテストのタブ、通知、サイドバーを写さない
        await closeAllEditors();
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
        await vscode.commands.executeCommand('workbench.action.closePanel');
        await vscode.commands.executeCommand('notifications.clearAll');
        const look: Array<[section: string, key: string, value: unknown]> = [
          ['editor', 'minimap.enabled', false],
          ['editor', 'lightbulb.enabled', 'off'],
          ['breadcrumbs', 'enabled', false], // 開発用のフォルダのパスを写さない
          ['git', 'decorations.enabled', false],
          // 撮影用に広げたウィンドウの幅に合わせ、訳文をなるべく省略せずに見せる
          ['interlinear', 'inlineMaxWidth', 170],
        ];
        for (const [section, key, value] of look) {
          await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
        }
        const sample = fixture('showcase.ts');
        const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sample));
        const lineOf = (text: string) => editor.document.getText().split('\n').findIndex((l) => l.includes(text));
        try {
          // README では JSDoc にも訳文が並ぶ all を見せる（既定の short との違いは README に書く）
          await showInline(sample, 'all');
          await shoot('readme-inline-all');
          await setConfig('inlineTranslation', 'short');

          const comment = new vscode.Position(lineOf('The delay doubles'), 8);
          let text = '';
          await waitFor('comment hover', () => /[\p{Script=Hiragana}\p{Script=Han}]/u.test(text), 60_000, async () => {
            text = await hoverText(editor.document, comment.line, comment.character);
          });
          await showHoverAt(editor, comment);
          await shoot('readme-hover');

          // 説明の短い Math.random にするのは、ホバーの高さに上限があり、長い説明だと訳文がスクロールの先に隠れるため
          const random = new vscode.Position(lineOf('Math.random'), editor.document.lineAt(lineOf('Math.random')).text.indexOf('random') + 2);
          text = '';
          await waitFor('documentation hover', () => /ローカル翻訳/.test(text), 120_000, async () => {
            text = await hoverText(editor.document, random.line, random.character);
          });
          // 開き直すのは、コマンドで開いたホバーはカーソルを動かしても閉じず、次のホバーが出ないため
          await closeAllEditors();
          await showHoverAt(await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sample)), random);
          await shoot('readme-doc-hover');
        } finally {
          await setConfig('inlineTranslation', 'off');
          for (const [section, key] of look) {
            await vscode.workspace.getConfiguration(section).update(key, undefined, vscode.ConfigurationTarget.Global);
          }
        }
      },
    ]);
  }

  const failures: string[] = [];
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✔ ${name}`);
    } catch (e) {
      console.log(`  ✖ ${name}\n${e instanceof Error ? e.stack : String(e)}`);
      failures.push(name);
    }
  }
  await mock.close().catch(() => {});
  console.log(`\n${tests.length - failures.length}/${tests.length} passed`);
  if (failures.length > 0) throw new Error(`${failures.length} test(s) failed`);
}
