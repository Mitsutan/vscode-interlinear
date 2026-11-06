import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { LlamaClient } from '../../src/core/llama-client.ts';

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

async function withServer(handler: Handler, fn: (url: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => handler(req, body, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

test('probe: llama-server なら ok とモデル名', async () => {
  await withServer(
    (req, _b, res) => {
      if (req.url === '/health') return json(res, 200, { status: 'ok' });
      if (req.url === '/props') return json(res, 200, { model_path: '/m/plamo-3-translate-2b-Q4_K_M.gguf' });
      json(res, 404, {});
    },
    async (url) => assert.deepEqual(await new LlamaClient(url).probe(), { status: 'ok', model: 'plamo-3-translate-2b-Q4_K_M' }),
  );
});

test('probe: モデル読み込み中（/health が 503）', async () => {
  await withServer(
    (_req, _b, res) => json(res, 503, { error: { code: 503, message: 'Loading model', type: 'unavailable_error' } }),
    async (url) => assert.deepEqual(await new LlamaClient(url).probe(), { status: 'loading' }),
  );
});

test('probe: 別のアプリが応答した', async () => {
  // HTML を返す Web アプリ
  await withServer(
    (_req, _b, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>other app</html>');
    },
    async (url) => assert.deepEqual(await new LlamaClient(url).probe(), { status: 'not-llama' }),
  );
  // /health は ok を返すが /props がない API サーバー
  await withServer(
    (req, _b, res) => (req.url === '/health' ? json(res, 200, { status: 'ok' }) : json(res, 404, {})),
    async (url) => assert.deepEqual(await new LlamaClient(url).probe(), { status: 'not-llama' }),
  );
});

test('probe: 接続できない', async () => {
  let closedUrl = '';
  await withServer(
    (_req, _b, res) => res.end(),
    async (url) => {
      closedUrl = url;
    },
  );
  assert.deepEqual(await new LlamaClient(closedUrl).probe(), { status: 'unreachable' });
});

test('translate: PFML3 プロンプトと停止トークンを送り、出力を整える', async () => {
  let sent: Record<string, unknown> = {};
  await withServer(
    (req, body, res) => {
      assert.equal(req.url, '/completion');
      sent = JSON.parse(body) as Record<string, unknown>;
      json(res, 200, { content: ' 訳文。<|plamo:tag|>', stop_type: 'limit', timings: { prompt_n: 3, predicted_n: 2, predicted_per_second: 10 } });
    },
    async (url) => {
      const r = await new LlamaClient(`${url}/`).translate({ text: 'Text.', targetLang: 'ja', form: 'plain' });
      assert.equal(r.text, '訳文。');
      assert.equal(r.truncated, true);
      assert.equal(r.timings.promptTokens, 3);
    },
  );
  assert.match(String(sent.prompt), /<\|plamo:tag\|>input<\|plamo:msg\|>Text\.<\|plamo:tag\|>output<\|plamo:key\|>lang<\|plamo:val\|>ja<\|plamo:key\|>form<\|plamo:val\|>plain<\|plamo:msg\|>$/);
  assert.deepEqual(sent.stop, ['<|plamo:tag|>', '<|plamo:bos|>']);
  assert.equal(sent.temperature, 0);
});
