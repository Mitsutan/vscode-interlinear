import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { IntegrityError, downloadVerified, extractArchive, findFile } from '../../src/managed/download.ts';
import { Installer } from '../../src/managed/installer.ts';
import { ManagedServer } from '../../src/managed/managedServer.ts';
import { LLAMA_ASSETS, MODELS, llamaIncompatibility } from '../../src/managed/manifest.ts';

const work = await mkdtemp(path.join(tmpdir(), 'interlinear-managed-'));
after(() => rm(work, { recursive: true, force: true }));
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function serveFiles(files: Record<string, Buffer>): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const body = files[req.url ?? ''];
    if (!body) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('content-length', body.length);
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ---------------------------------------------------------------------------

test('manifest: すべてのプラットフォームとモデルに URL・サイズ・SHA-256 がある', () => {
  for (const a of [...Object.values(LLAMA_ASSETS), ...Object.values(MODELS)]) {
    assert.match(a.url, /^https:\/\//);
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.ok(a.bytes > 0);
    assert.ok(a.url.endsWith(a.name));
  }
  // モデルはコミットを指定した URL にする（ファイルが差し替えられても影響を受けない）
  for (const m of Object.values(MODELS)) assert.match(m.url, /\/resolve\/[0-9a-f]{40}\//);
});

test('manifest: Linux 版は必要な glibc より古い環境と、glibc でない環境では使えない', () => {
  for (const [key, a] of Object.entries(LLAMA_ASSETS)) assert.equal(Boolean(a.minGlibc), key.startsWith('linux-'), key);

  const linux = { ...LLAMA_ASSETS['linux-arm64']!, minGlibc: '2.38' };
  assert.equal(llamaIncompatibility(linux, '2.38'), undefined);
  assert.equal(llamaIncompatibility(linux, '2.41'), undefined);
  assert.match(llamaIncompatibility(linux, '2.36') ?? '', /glibc 2\.38 or later.*2\.36/);
  assert.match(llamaIncompatibility(linux, '2.4') ?? '', /2\.38 or later/); // 文字列ではなく数値で比べる
  assert.match(llamaIncompatibility(linux, undefined) ?? '', /musl/);
  assert.equal(llamaIncompatibility(LLAMA_ASSETS['darwin-arm64']!, undefined), undefined);
});

test('download: ハッシュが一致したときだけ保存し、進捗を知らせる', async () => {
  const body = Buffer.from('model weights'.repeat(1000));
  const srv = await serveFiles({ '/ok.bin': body });
  try {
    const dest = path.join(work, 'dl', 'ok.bin');
    const seen: number[] = [];
    await downloadVerified(`${srv.url}/ok.bin`, dest, sha256(body), { onProgress: (p) => seen.push(p.received) });
    assert.deepEqual(await readFile(dest), body);
    assert.equal(seen.at(-1), body.length);

    const bad = path.join(work, 'dl', 'bad.bin');
    await assert.rejects(downloadVerified(`${srv.url}/ok.bin`, bad, '0'.repeat(64)), IntegrityError);
    assert.equal(existsSync(bad), false);
    assert.equal(existsSync(`${bad}.part`), false, '途中のファイルを残さない');

    await assert.rejects(downloadVerified(`${srv.url}/missing`, path.join(work, 'dl', 'x'), '0'.repeat(64)), /HTTP 404/);
  } finally {
    await srv.close();
  }
});

test('extractArchive / findFile: tar.gz を展開して llama-server を見つける', async () => {
  const src = path.join(work, 'archive-src');
  await mkdir(path.join(src, 'llama-b1'), { recursive: true });
  await writeFile(path.join(src, 'llama-b1', 'llama-server'), '#!/bin/sh\n');
  const archive = path.join(work, 'llama.tar.gz');
  await promisify(execFile)('tar', ['-czf', archive, '-C', src, 'llama-b1']);
  const dest = path.join(work, 'archive-dest');
  await extractArchive(archive, dest);
  assert.equal(await findFile(dest, ['llama-server']), path.join(dest, 'llama-b1', 'llama-server'));
  assert.equal(await findFile(path.join(work, 'nowhere'), ['llama-server']), undefined);
});

test('Installer: llama.cpp を取得・検証・展開し、ダウンロードしたアーカイブは消す', async () => {
  const src = path.join(work, 'inst-src');
  await mkdir(path.join(src, 'llama-b1'), { recursive: true });
  await writeFile(path.join(src, 'llama-b1', 'llama-server'), '#!/bin/sh\n');
  const archive = path.join(work, 'inst.tar.gz');
  await promisify(execFile)('tar', ['-czf', archive, '-C', src, 'llama-b1']);
  const bytes = await readFile(archive);
  const srv = await serveFiles({ '/llama.tar.gz': bytes });
  try {
    const root = path.join(work, 'storage');
    const installer = new Installer(root, 'test-platform', {
      url: `${srv.url}/llama.tar.gz`,
      name: 'llama.tar.gz',
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
    assert.equal(await installer.findLlamaServer(), undefined);
    const server = await installer.installLlama();
    assert.ok(server.endsWith(path.join('llama-b1', 'llama-server')));
    assert.equal(await installer.findLlamaServer(), server);
    assert.deepEqual(await readdir(path.join(root, 'downloads')), []);
    assert.equal(await installer.isModelInstalled('2b'), false);
  } finally {
    await srv.close();
  }
});

test('Installer: 環境に合わない llama.cpp はダウンロードしない', async () => {
  const asset = { url: 'http://127.0.0.1:1/unreachable.tar.gz', name: 'llama.tar.gz', bytes: 1, sha256: '0'.repeat(64), minGlibc: '2.38' };
  const old = new Installer(path.join(work, 'storage-old-glibc'), 'linux-arm64', asset, () => '2.36');
  assert.match(old.unsupportedReason ?? '', /glibc 2\.38 or later/);
  await assert.rejects(old.installLlama(), /glibc 2\.38 or later/);
  assert.equal(existsSync(path.join(work, 'storage-old-glibc', 'downloads')), false);

  assert.equal(new Installer(work, 'linux-arm64', asset, () => '2.39').unsupportedReason, undefined);
  assert.match(new Installer(work, 'aix-ppc64', undefined).unsupportedReason ?? '', /aix-ppc64/);
});

// ---------------------------------------------------------------------------
// ManagedServer: llama-server の代わりの偽サーバーで、起動・停止・異常終了の扱いを確かめる

const FAKE_SERVER = `#!/usr/bin/env node
const http = require('node:http');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const model = args[args.indexOf('-m') + 1];
if (model.includes('crash')) process.exit(3);
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok' }));
    if (req.url === '/props') return res.end(JSON.stringify({ model_path: model }));
    if (req.url === '/completion') return res.end(JSON.stringify({ content: '訳:' + process.pid, stop_type: 'eos' }));
    res.statusCode = 404; res.end('{}');
  });
}).listen(port, '127.0.0.1');
`;

async function fakeServerPath(): Promise<string> {
  const p = path.join(work, 'fake-llama-server');
  if (!existsSync(p)) {
    await writeFile(p, FAKE_SERVER);
    await chmod(p, 0o755);
  }
  return p;
}

function managed(model: string, opts: { idleTimeoutMs?: number; server?: string | undefined } = {}) {
  const logs: string[] = [];
  const server = new ManagedServer({
    serverPath: async () => ('server' in opts ? opts.server : fakeServerPath()),
    modelPath: async () => model,
    parallel: 2,
    idleTimeoutMs: opts.idleTimeoutMs ?? 0,
    log: (l) => logs.push(l),
    startTimeoutMs: 10_000,
  });
  return { server, logs };
}

const req = { text: 'Hello.', targetLang: 'ja' };

test('ManagedServer: 使われたときに起動し、空いているポートで翻訳できる', async () => {
  const { server, logs } = managed('/models/fake-2b.gguf');
  try {
    assert.equal(server.running, false);
    assert.deepEqual(await server.probe(), { status: 'ok', model: 'fake-2b' });
    assert.equal(server.running, true);
    assert.match((await server.translate(req)).text, /^訳:\d+$/);
    assert.ok(logs.some((l) => l.includes('--port')));
  } finally {
    await server.dispose();
  }
  assert.equal(server.running, false);
});

test('ManagedServer: しばらく使われなければ止め、次に使われたら起動し直す', async () => {
  const { server } = managed('/models/fake-2b.gguf', { idleTimeoutMs: 200 });
  try {
    const first = (await server.translate(req)).text;
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(server.running, false, '止まっている');
    const second = (await server.translate(req)).text;
    assert.notEqual(second, first, '別のプロセスで起動し直している');
  } finally {
    await server.dispose();
  }
});

test('ManagedServer: 準備ができていなければ理由を返す', async () => {
  const { server } = managed('/models/fake-2b.gguf', { server: undefined });
  const probe = await server.probe();
  assert.equal(probe.status, 'unavailable');
  assert.match(probe.status === 'unavailable' ? probe.message : '', /Run setup/);
  await server.dispose();
});

test('ManagedServer: 起動直後に終了したら理由を返し、繰り返したら起動をやめる。再起動で記録を消す', async () => {
  const { server } = managed('/models/crash.gguf');
  try {
    for (let i = 0; i < 3; i++) {
      const p = await server.probe();
      assert.match(p.status === 'unavailable' ? p.message : '', /exited right after starting/);
    }
    const p = await server.probe();
    assert.match(p.status === 'unavailable' ? p.message : '', /crashed repeatedly/);
    const r = await server.restart();
    assert.match(r.status === 'unavailable' ? r.message : '', /exited right after starting/, '再起動すると、もう一度起動を試みる');
  } finally {
    await server.dispose();
  }
});

// 本物の llama-server とモデルを指定したときだけ、実際に起動して翻訳する（統合テストと同じ環境変数）
const realServer = process.env.INTERLINEAR_REAL_LLAMA_SERVER;
const realModel = process.env.INTERLINEAR_REAL_MODEL ?? '';
test('ManagedServer: 本物の llama-server で起動して翻訳する', { skip: !realServer || !existsSync(realModel) }, async () => {
  const logs: string[] = [];
  const server = new ManagedServer({
    serverPath: async () => realServer,
    modelPath: async () => realModel,
    parallel: 1,
    idleTimeoutMs: 0,
    log: (l) => logs.push(l),
  });
  try {
    const probe = await server.probe();
    assert.deepEqual(probe, { status: 'ok', model: path.basename(realModel, '.gguf') }, logs.slice(-20).join('\n'));
    const { text } = await server.translate({ text: 'The meeting was moved to next Monday.', targetLang: 'ja', form: 'plain' });
    assert.match(text, /[\p{Script=Hiragana}\p{Script=Han}]/u);
  } finally {
    await server.dispose();
  }
});

test('package.json: 実行ファイルとモデルのパスはワークスペース設定で指定できず、接続先は信頼されていないワークスペースから変更できない', async () => {
  const pkg = JSON.parse(await readFile(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { scope?: string }> } };
    capabilities: { untrustedWorkspaces: { supported: string; restrictedConfigurations: string[] } };
  };
  const props = pkg.contributes.configuration.properties;
  assert.equal(props['interlinear.server.llamaServerPath']?.scope, 'machine');
  assert.equal(props['interlinear.server.modelPath']?.scope, 'machine');
  const untrusted = pkg.capabilities.untrustedWorkspaces;
  assert.equal(untrusted.supported, 'limited');
  for (const key of ['interlinear.server.mode', 'interlinear.endpoint', 'interlinear.server.llamaServerPath', 'interlinear.server.modelPath']) {
    assert.ok(untrusted.restrictedConfigurations.includes(key), key);
  }
});

test('package.json: リモート開発ではホスト側で動き、ホスト側で動けない（ブラウザ版など）ときはリモート側で動く', async () => {
  const pkg = JSON.parse(await readFile(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { extensionKind: string[] };
  assert.deepEqual(pkg.extensionKind, ['ui', 'workspace']);
});
