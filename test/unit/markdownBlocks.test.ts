import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reassemble } from '../../src/core/normalize.ts';
import { hasProse, restoreLinks, segmentMarkdown } from '../../src/core/markdownBlocks.ts';

// VS Code の TypeScript 拡張が返すホバーの形式
const TS_HOVER = [
  '```typescript',
  'function readFileSync(path: PathOrFileDescriptor): Buffer',
  '```',
  'Returns the contents of the `path`.',
  '',
  'For details, see [readFile](command:_typescript.openJsDocLink?%5B%7B%22file%22%3A1%7D%5D) and',
  'the [docs](https://nodejs.org/api/fs.html "Node.js docs").',
  '',
  '*@param* `path` — filename or file descriptor',
  '',
  '*@param* `options`  ',
  'Options that span',
  'multiple lines.',
  '',
  '*@since* — v0.1.8',
  '',
  '*@example*  ',
  '```js',
  "readFileSync('/etc/passwd');",
  '```',
].join('\n');

const prose = (seg: ReturnType<typeof segmentMarkdown>) =>
  seg.blocks.flatMap((b) => (b.type === 'prose' ? [[b.prefix, b.text]] : []));

test('TypeScript のホバー: コードは除き、文章とタグの説明だけを訳す', () => {
  const seg = segmentMarkdown(TS_HOVER, 'ja');
  assert.equal(seg.signature, 'function readFileSync(path: PathOrFileDescriptor): Buffer');
  assert.deepEqual(prose(seg), [
    ['', 'Returns the contents of the `path`.'],
    ['', 'For details, see [readFile](L0) and the [docs](L1).'],
    ['*@param* `path` — ', 'filename or file descriptor'],
    ['*@param* `options` ', 'Options that span multiple lines.'],
  ]);
  assert.deepEqual(seg.links, [
    'command:_typescript.openJsDocLink?%5B%7B%22file%22%3A1%7D%5D',
    'https://nodejs.org/api/fs.html "Node.js docs"',
  ]);
  // @since は文章がほとんどないので訳さない。@example とコードブロックは表示しない
  const text = reassemble(seg.blocks, new Map());
  assert.match(text, /\*@since\* — v0\.1\.8/);
  assert.doesNotMatch(text, /readFileSync\(/);
  assert.doesNotMatch(text, /```/);
});

test('リンクは元に戻し、モデルが作ったリンクは外す', () => {
  const links = ['command:_typescript.openJsDocLink?x', 'https://example.com'];
  assert.equal(
    restoreLinks('詳しくは [readFile](L0) と[ドキュメント](L1)を参照。[罠](command:workbench.action.reloadWindow) <command:evil>', links),
    '詳しくは [readFile](command:_typescript.openJsDocLink?x) と[ドキュメント](https://example.com)を参照。罠 command:evil',
  );
  // 番号が範囲外なら文字だけ残す（リンクにはしない）
  assert.equal(restoreLinks('[x](L9)', links), 'x');
});

test('出力言語で書かれたドキュメントやシグネチャだけのホバーは訳さない', () => {
  assert.equal(hasProse(segmentMarkdown('```ts\nconst x: number\n```', 'ja')), false);
  assert.equal(hasProse(segmentMarkdown('```ts\nfunction f(): void\n```\n設定ファイルを読み込む。', 'ja')), false);
  assert.equal(hasProse(segmentMarkdown('```ts\nfunction f(): void\n```\n設定ファイルを読み込む。', 'en')), true);
});

test('見出し・引用・リスト・表', () => {
  const seg = segmentMarkdown('## Usage\n\n> Note: this is\n> deprecated.\n\n- First item\n- Second item\n\n| a | b |\n|---|---|', 'ja');
  assert.deepEqual(prose(seg), [
    ['## ', 'Usage'],
    ['> ', 'Note: this is deprecated.'],
    ['- ', 'First item'],
    ['- ', 'Second item'],
  ]);
  assert.match(reassemble(seg.blocks, new Map()), /\| a \| b \|/);
});
