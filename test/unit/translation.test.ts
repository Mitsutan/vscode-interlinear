import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ProbeResult } from '../../src/core/llama-client.ts';
import { normalize } from '../../src/core/normalize.ts';
import type { TranslateRequest } from '../../src/core/pfml3.ts';
import { TranslationCache } from '../../src/translation/cache.ts';
import { CancelledError, Priority, TaskQueue } from '../../src/translation/queue.ts';
import { ServerUnavailableError, type TranslationBackend, TranslationService } from '../../src/translation/service.ts';
import { extractComments } from './helpers.ts';

const tick = () => new Promise((r) => setImmediate(r));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// TranslationCache

test('cache: LRU で古いものから捨てる', () => {
  const c = new TranslationCache({ maxEntries: 2 });
  c.set('a', '1');
  c.set('b', '2');
  c.get('a'); // a を最新にする
  c.set('c', '3');
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), '1');
  assert.equal(c.get('c'), '3');
});

test('cache: 保存して読み込める。壊れたファイルは無視する', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cache-test-'));
  try {
    const file = path.join(dir, 'sub', 'cache.json');
    const c1 = new TranslationCache({ maxEntries: 10, file });
    c1.set('k', '訳');
    await c1.flush();
    const c2 = new TranslationCache({ maxEntries: 10, file });
    await c2.load();
    assert.equal(c2.get('k'), '訳');

    const broken = new TranslationCache({ maxEntries: 10, file: path.join(dir, 'missing.json') });
    await broken.load();
    assert.equal(broken.size, 0);
    assert.ok((await readFile(file, 'utf8')).startsWith('{"version":1'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cache: キーはモデルとプロンプトで決まる', () => {
  assert.equal(TranslationCache.key('m', 'p'), TranslationCache.key('m', 'p'));
  assert.notEqual(TranslationCache.key('m1', 'p'), TranslationCache.key('m2', 'p'));
});

// ---------------------------------------------------------------------------
// TaskQueue

test('queue: 同時実行数を守り、優先度の高いものから実行する', async () => {
  const q = new TaskQueue(1);
  const order: string[] = [];
  const gate = deferred<void>();
  const first = q.run('first', Priority.Visible, async () => {
    order.push('first');
    await gate.promise;
    return 1;
  });
  const visible = q.run('visible', Priority.Visible, async () => (order.push('visible'), 2));
  const hover = q.run('hover', Priority.Interactive, async () => (order.push('hover'), 3));
  await tick();
  assert.deepEqual(order, ['first']);
  gate.resolve();
  await Promise.all([first.promise, visible.promise, hover.promise]);
  assert.deepEqual(order, ['first', 'hover', 'visible']);
});

test('queue: 同じキーはまとめ、待機中に優先度を引き上げる', async () => {
  const q = new TaskQueue(1);
  const gate = deferred<void>();
  let calls = 0;
  q.run('busy', Priority.Visible, () => gate.promise);
  const a = q.run('same', Priority.Visible, async () => (calls++, 'x'));
  const other = q.run('other', Priority.Visible, async () => 'o');
  const b = q.run('same', Priority.Interactive, async () => (calls++, 'y'));
  assert.equal(q.pending, 3);
  gate.resolve();
  assert.equal(await a.promise, 'x');
  assert.equal(await b.promise, 'x');
  assert.equal(calls, 1);
  await other.promise;
});

test('queue: 待機中のタスクは全員が取り消したら捨てる。実行中は最後まで走る', async () => {
  const q = new TaskQueue(1);
  const gate = deferred<void>();
  const running = q.run('running', Priority.Visible, () => gate.promise.then(() => 'done'));
  const a = q.run('queued', Priority.Visible, async () => 'never');
  const b = q.run('queued', Priority.Visible, async () => 'never');
  a.cancel();
  assert.equal(q.pending, 2); // b がまだ待っている
  b.cancel();
  await assert.rejects(a.promise, CancelledError);
  assert.equal(q.pending, 1);
  running.cancel(); // 実行中は止まらない
  gate.resolve();
  assert.equal(await running.promise, 'done');
});

// ---------------------------------------------------------------------------
// TranslationService

class FakeBackend implements TranslationBackend {
  up = true;
  model = 'fake-model';
  requests: TranslateRequest[] = [];
  async probe(): Promise<ProbeResult> {
    return this.up ? { status: 'ok', model: this.model } : { status: 'unreachable' };
  }
  async translate(req: TranslateRequest) {
    if (!this.up) throw new TypeError('fetch failed');
    this.requests.push(req);
    return { text: `[訳]${req.text}` };
  }
}

async function unitFrom(source: string, file = 'a.ts') {
  const units = normalize(await extractComments(file, source), { targetLang: 'ja' });
  const unit = units.find((u) => !u.skip);
  assert.ok(unit);
  return unit;
}

function makeService(backend: FakeBackend, overrides: Partial<ConstructorParameters<typeof TranslationService>[1]> = {}) {
  return new TranslationService(
    backend,
    { endpoint: 'http://test', targetLang: 'ja', form: 'plain', useContext: true, glossary: [], ...overrides },
    new TranslationCache({ maxEntries: 100 }),
    new TaskQueue(2),
  );
}

test('service: 段落ごとに訳して元の構造に組み戻し、2回目はキャッシュから返す', async () => {
  const backend = new FakeBackend();
  const service = makeService(backend);
  const unit = await unitFrom('/**\n * Summary.\n *\n * @param x - The value.\n */\nfunction f(x) {}');
  assert.equal(service.peek(unit), undefined);

  const text = await service.translate(unit, Priority.Interactive).promise;
  assert.equal(text, '[訳]Summary.\n\n@param x - [訳]The value.');
  assert.equal(backend.requests.length, 2);
  assert.match(backend.requests[0]!.context ?? '', /Related code: function f\(x\) \{\}/);
  assert.equal(backend.requests[0]!.form, 'plain');

  assert.equal(service.peek(unit), text);
  await service.translate(unit, Priority.Interactive).promise;
  assert.equal(backend.requests.length, 2);
});

test('service: 用語集は原文に出てくる語だけを渡す', async () => {
  const backend = new FakeBackend();
  const service = makeService(backend, {
    useContext: false,
    glossary: [
      { source: 'widget', target: 'ウィジェット' },
      { source: 'unrelated', target: '無関係' },
    ],
  });
  await service.translate(await unitFrom('// Render the widget.\nf();'), Priority.Interactive).promise;
  assert.deepEqual(backend.requests[0]!.glossary, [{ source: 'widget', target: 'ウィジェット' }]);
  assert.equal(backend.requests[0]!.context, undefined);
});

test('service: モデルが変わるとキャッシュのキーも変わる', async () => {
  const backend = new FakeBackend();
  const service = makeService(backend);
  const unit = await unitFrom('// Hello there.\nf();');
  await service.translate(unit, Priority.Interactive).promise;
  backend.model = 'other-model';
  service.reconfigure(backend, service.currentSettings);
  await service.checkServer();
  assert.equal(service.peek(unit), undefined);
});

test('service: 接続できないときは、先読みはすぐ失敗し、ホバーは確認し直す', async () => {
  const backend = new FakeBackend();
  backend.up = false;
  let now = 0;
  const service = new TranslationService(
    backend,
    { endpoint: 'http://test', targetLang: 'ja', useContext: false, glossary: [] },
    new TranslationCache({ maxEntries: 10 }),
    new TaskQueue(1),
    () => now,
  );
  const unit = await unitFrom('// Hello there.\nf();');
  await assert.rejects(service.translate(unit, Priority.Interactive).promise, ServerUnavailableError);
  assert.equal(service.serverState.status, 'down');

  backend.up = true;
  now += 1000;
  // 先読みは一定時間止めておく
  await assert.rejects(service.translate(unit, Priority.Visible).promise, ServerUnavailableError);
  // ホバーは確認し直して成功する
  assert.equal(await service.translate(unit, Priority.Interactive).promise, '[訳]Hello there.');
  assert.equal(service.serverState.status, 'ok');
});

test('service: 翻訳中に接続が切れたら、利用者向けのエラーにして状態を down にする', async () => {
  const backend = new FakeBackend();
  const service = makeService(backend);
  await service.checkServer();
  backend.up = false; // 状態は ok のまま、リクエストだけ失敗する
  await assert.rejects(
    service.translate(await unitFrom('// Hello there.\nf();'), Priority.Interactive).promise,
    (e: unknown) => e instanceof ServerUnavailableError && /http:\/\/test/.test(e.message),
  );
  assert.equal(service.serverState.status, 'down');
});

test('service: 応答したのが llama-server でなければ、その旨を伝える', async () => {
  const backend = new FakeBackend();
  backend.probe = async () => ({ status: 'not-llama' });
  const service = makeService(backend);
  const state = await service.checkServer();
  assert.equal(state.status, 'down');
  assert.match(state.status === 'down' ? state.message : '', /llama-server ではありません/);
});

test('service: 設定変更前に始まった接続確認の結果は使わない', async () => {
  const slow = new FakeBackend();
  const gate = deferred<void>();
  slow.model = 'old-model';
  const origProbe = slow.probe.bind(slow);
  slow.probe = async () => (await gate.promise, origProbe());
  const service = makeService(slow);
  const stale = service.checkServer();

  const fresh = new FakeBackend();
  fresh.model = 'new-model';
  service.reconfigure(fresh, service.currentSettings);
  const state = await service.checkServer();
  assert.deepEqual(state, { status: 'ok', model: 'new-model' });

  gate.resolve();
  await stale;
  assert.deepEqual(service.serverState, { status: 'ok', model: 'new-model' });
});

test('service: 訳し終わった段落だけを返し、翻訳が終わるたびに知らせる', async () => {
  const backend = new FakeBackend();
  const service = makeService(backend);
  const unit = await unitFrom('/**\n * Summary.\n *\n * @param x - The value.\n */\nfunction f(x) {}');
  await service.checkServer();
  assert.equal(service.peekBlocks(unit).size, 0);
  let notified = 0;
  service.onDidTranslate(() => notified++);
  await service.translate(unit, Priority.Visible).promise;
  assert.equal(notified, 2);
  assert.deepEqual([...service.peekBlocks(unit).values()], ['[訳]Summary.', '[訳]The value.']);
});
