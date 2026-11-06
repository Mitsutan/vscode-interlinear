import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractComments } from './helpers.ts';
import { countPreserved, extractProtectedTokens } from '../../src/core/glossary.ts';
import { classifyLine, normalize, reassemble, toBlocks } from '../../src/core/normalize.ts';

const units = async (file: string, source: string, targetLang = 'ja') =>
  normalize(await extractComments(file, source), { targetLang });

test('列位置は UTF-16 コード単位（VS Code の Position.character と同じ）', async () => {
  const line = "const s = '日本語の文字列'; // trailing";
  const [c] = await extractComments('a.ts', line);
  assert.equal(c?.startColumn, line.indexOf('//'));
  assert.equal(c?.trailing, true);
});

test('連続する行コメントはまとめ、行末コメントとコードの行は分ける', async () => {
  const us = await units(
    'a.ts',
    [
      'foo(); // trailing one',
      '// First line of a',
      '// wrapped sentence.',
      '// const legacy = parse(x);',
      '// TODO: remove this.',
    ].join('\n'),
  );
  assert.deepEqual(
    us.map((u) => [u.kind, u.body, u.skip ?? 'ok']),
    [
      ['trailing', 'trailing one', 'ok'],
      ['line', 'First line of a\nwrapped sentence.', 'ok'],
      ['line', 'const legacy = parse(x);', 'code'],
      ['line', 'TODO: remove this.', 'ok'],
    ],
  );
  assert.deepEqual(us[1]!.blocks, [{ type: 'prose', prefix: '', text: 'First line of a wrapped sentence.' }]);
});

test('JSDoc: タグ名・引数名・@example は残し、説明文だけ訳す', () => {
  const blocks = toBlocks(
    [
      'Summary line.',
      '',
      '@param {string} name - The name.',
      '@param [opts] Options that',
      '  continue here.',
      '@returns',
      '@example',
      'foo("x");',
      '@since 1.0',
    ].join('\n'),
  );
  assert.deepEqual(blocks, [
    { type: 'prose', prefix: '', text: 'Summary line.' },
    { type: 'verbatim', text: '' },
    { type: 'prose', prefix: '@param {string} name - ', text: 'The name.' },
    { type: 'prose', prefix: '@param [opts] ', text: 'Options that continue here.' },
    { type: 'verbatim', text: '@returns' },
    { type: 'verbatim', text: '@example' },
    { type: 'verbatim', text: 'foo("x");' },
    { type: 'verbatim', text: '@since 1.0' },
  ]);
  const out = reassemble(blocks, new Map([[0, '要約。'], [2, '名前。']]));
  assert.equal(out.split('\n')[0], '要約。');
  assert.equal(out.split('\n')[2], '@param {string} name - 名前。');
});

test('コードフェンスと doctest は verbatim', () => {
  const blocks = toBlocks(['Intro.', '```js', 'a = 1', '```', '>>> f()', '1', '', 'After.'].join('\n'));
  assert.deepEqual(
    blocks.filter((b) => b.type === 'prose').map((b) => b.text),
    ['Intro.', 'After.'],
  );
});

test('飾り線は verbatim のまま、見出しだけ訳す', () => {
  assert.deepEqual(toBlocks('------\nSection title\n------'), [
    { type: 'verbatim', text: '------' },
    { type: 'prose', prefix: '', text: 'Section title' },
    { type: 'verbatim', text: '------' },
  ]);
});

test('Python: docstring と Google スタイルの Args', async () => {
  const us = await units(
    'a.py',
    ['def f(rate):', '    """Do it.', '', '    Args:', '        rate (float): Tokens per second.', '    """', '    pass'].join('\n'),
  );
  assert.equal(us.length, 1);
  assert.equal(us[0]!.kind, 'docstring');
  assert.equal(us[0]!.codeLine, 'def f(rate):');
  assert.deepEqual(
    us[0]!.blocks.filter((b) => b.type === 'prose'),
    [
      { type: 'prose', prefix: '', text: 'Do it.' },
      { type: 'prose', prefix: '    rate (float): ', text: 'Tokens per second.' },
    ],
  );
});

test('除外理由', async () => {
  const us = await units(
    'a.py',
    [
      '#!/usr/bin/env python3',
      'import os  # noqa: F401',
      '# ------',
      'a = 1',
      '# 日本語のコメント',
      'b = 2',
      '# Real comment here.',
    ].join('\n'),
  );
  assert.deepEqual(
    us.map((u) => u.skip ?? 'ok'),
    ['directive', 'directive', 'decorative', 'already-target', 'ok'],
  );
  // 出力言語が英語なら、日本語コメントは翻訳対象
  const en = await units('a.py', '# 日本語のコメント', 'en');
  assert.equal(en[0]!.skip, undefined);
});

test('classifyLine', () => {
  assert.equal(classifyLine('print(self._tokens)'), 'code');
  assert.equal(classifyLine('self._debug = True'), 'code');
  assert.equal(classifyLine('for example: this is prose'), 'prose');
  assert.equal(classifyLine('Return True if consumed.'), 'prose');
});

test('RST の二重バッククォートと Markdown リンク', () => {
  // 隣り合うコードの「間の英文」を拾わないこと（以前のバグ）
  assert.deepEqual(
    new Set(extractProtectedTokens('Deserialize ``s`` (a ``str``, ``bytes`` or ``bytearray`` instance)')),
    new Set(['bytearray', 'bytes', 'str']),
  );
  assert.deepEqual(extractProtectedTokens('The [`Readable`](https://nodejs.org/api/stream.html#x) stream'), [
    'https://nodejs.org/api/stream.html#x',
    'Readable',
  ]);
});

test('段落の先頭にあるシグネチャ行や表の行は verbatim', () => {
  const blocks = toBlocks('_wrap_chunks(chunks : [string]) -> [string]\n\nWrap a sequence.\n\n00 XX 00 XX - utf-16-be');
  assert.deepEqual(
    blocks.filter((b) => b.type === 'prose').map((b) => b.text),
    ['Wrap a sequence.'],
  );
});

test('保護トークンの抽出と保持率', () => {
  const src = 'Calls `logger.warn()` via fs.readFile() when APP_PORT or maxRetries is set, e.g. see https://example.com/x.';
  assert.deepEqual(
    new Set(extractProtectedTokens(src)),
    new Set(['logger.warn()', 'fs.readFile()', 'APP_PORT', 'maxRetries', 'https://example.com/x']),
  );
  assert.deepEqual(countPreserved(src, '`logger.warn()` を呼ぶ。APP_PORT が…'), { total: 5, kept: 2 });
});
