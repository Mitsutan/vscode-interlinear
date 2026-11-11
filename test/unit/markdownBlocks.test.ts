import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reassemble } from '../../src/core/normalize.ts';
import { hasProse, renderTranslation, restoreLinks, segmentMarkdown } from '../../src/core/markdownBlocks.ts';

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

test('TypeScript のホバー: 文章とタグの説明だけを訳し、シグネチャは訳文に入れない', () => {
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
  // @since は文章がほとんどないので訳さない。@example のコードは元の形のまま残す
  const text = reassemble(seg.blocks, new Map());
  assert.match(text, /\*@since\* — v0\.1\.8/);
  assert.doesNotMatch(text, /function readFileSync/);
  assert.ok(text.endsWith("*@example*  \n```js\nreadFileSync('/etc/passwd');\n```"), text);
});

// gopls が返すホバーの形式（go/doc/comment の Markdown 出力）。段落は1行、コードはタブで字下げする
const GO_HOVER = [
  '```go',
  'package strconv',
  '```',
  '',
  '---',
  '',
  'Package strconv implements conversions to and from string representations of basic data types.',
  '',
  '### Numeric Conversions',
  '',
  'The most common numeric conversions are [Atoi] (string to int) and [Itoa] (int to string).',
  '',
  '\ti, err := strconv.Atoi("-42")',
  '\ts := strconv.Itoa(-42)',
  '',
  'The parse functions return the widest type:',
  '',
  '\ts := "2147483647" // biggest int32',
  '\ti64, err := strconv.ParseInt(s, 10, 32)',
  '',
  '\ti := int32(i64)',
  '',
  '[Unquote] and [UnquoteChar] unquote Go string and rune literals.',
].join('\n');

test('Go のホバー: 字下げのコードは訳さず、行も字下げも元のまま残す', () => {
  const seg = segmentMarkdown(GO_HOVER, 'ja');
  assert.equal(seg.signature, 'package strconv');
  assert.deepEqual(prose(seg), [
    ['', 'Package strconv implements conversions to and from string representations of basic data types.'],
    ['### ', 'Numeric Conversions'],
    ['', 'The most common numeric conversions are [Atoi] (string to int) and [Itoa] (int to string).'],
    ['', 'The parse functions return the widest type:'],
    ['', '[Unquote] and [UnquoteChar] unquote Go string and rune literals.'],
  ]);
  const text = reassemble(seg.blocks, new Map());
  assert.ok(text.startsWith('Package strconv implements'), text);
  assert.ok(text.includes('\n\n\ti, err := strconv.Atoi("-42")\n\ts := strconv.Itoa(-42)\n\n'), text);
  // コードの中の空行も残す
  assert.ok(text.includes('\n\ts := "2147483647" // biggest int32\n\ti64, err := strconv.ParseInt(s, 10, 32)\n\n\ti := int32(i64)\n'), text);
});

test('字下げのコードは、段落の途中やリスト項目の続きでは始まらない', () => {
  const seg = segmentMarkdown(
    [
      'A paragraph that is',
      '    continued lazily.',
      '',
      '  - First item',
      '',
      '    Second paragraph of the first item.',
      ' 1. Numbered item',
      '',
      '    Continued numbered item.',
      '',
      'After the list.',
      '',
      '    code()',
    ].join('\n'),
    'ja',
  );
  assert.deepEqual(prose(seg), [
    ['', 'A paragraph that is continued lazily.'],
    ['  - ', 'First item'],
    ['    ', 'Second paragraph of the first item.'],
    [' 1. ', 'Numbered item'],
    ['    ', 'Continued numbered item.'],
    ['', 'After the list.'],
  ]);
  assert.ok(reassemble(seg.blocks, new Map()).endsWith('\n\n    code()'));
});

test('段落の途中で 4 桁以上字下げした行は、見出しやリストなどにせず段落の続きにする', () => {
  // Ruby の言語サーバーは RDoc をそのまま返す（cgi.rb）。2 行目の "# ..." は、原文のホバーでも段落の一部として表示される
  const rdoc = [
    '=== Get form values',
    '',
    '  require "cgi"',
    "  value = cgi['field_name']   # <== value string for 'field_name'",
    "    # if not 'field_name' included, then return \"\".",
    '  fields = cgi.keys            # <== array of field names',
    '',
    "  # returns true if form has 'field_name'",
    "  cgi.has_key?('field_name')",
  ].join('\n');
  assert.deepEqual(prose(segmentMarkdown(rdoc, 'ja')), [
    ['', '=== Get form values'],
    [
      '  ',
      `require "cgi" value = cgi['field_name']   # <== value string for 'field_name' # if not 'field_name' included, then return "". fields = cgi.keys            # <== array of field names`,
    ],
    // 字下げが 3 桁までなら、空行の後の "# ..." は原文でも見出しになる
    ['# ', "returns true if form has 'field_name'"],
  ]);

  const others = segmentMarkdown(['Some text', '    - not a list', '    > not a quote', '    ---', '    ```', 'end.'].join('\n'), 'ja');
  assert.deepEqual(prose(others), [['', 'Some text - not a list > not a quote --- ``` end.']]);
});

test('本文中のコードブロックは、空行も含めて元の形のまま残し、シグネチャとして扱わない', () => {
  const python = ['```python', 'def f():', '    pass', '', '', 'def g():', '    pass', '```'].join('\n');
  const seg = segmentMarkdown(`Example usage:\n\n${python}\n\nMore text here.`, 'ja');
  assert.equal(seg.signature, undefined);
  assert.equal(reassemble(seg.blocks, new Map()), `Example usage:\n\n${python}\n\nMore text here.`);
});

test('区切り線の後ろでも、文章より前にあるコードブロックはシグネチャとして扱う（clangd は最後に置く）', () => {
  const clangd = [
    '### function `add`',
    '',
    '---',
    '→ `int`',
    '',
    'Adds two numbers and returns the sum.',
    '',
    '---',
    '```cpp',
    '// In namespace math',
    'int add(int a, int b)',
    '```',
  ].join('\n');
  const seg = segmentMarkdown(clangd, 'ja');
  assert.equal(seg.signature, '// In namespace math');
  const text = reassemble(seg.blocks, new Map());
  assert.ok(text.endsWith('Adds two numbers and returns the sum.'), text);
  assert.doesNotMatch(text, /int add\(/);
});

test('訳文を組み戻すとき、リンクは訳した段落だけで戻し、そのまま残したコードには触れない', () => {
  const seg = segmentMarkdown(
    ['    handlers[name](event);', '', 'Calls the [handler](https://example.com/handler) for the event.', '', '```ts', 'run(<a:b>);', '```'].join('\n'),
    'ja',
  );
  const index = seg.blocks.findIndex((b) => b.type === 'prose');
  const translated = renderTranslation(
    seg,
    new Map([[index, 'イベントの[ハンドラー](L0)を呼ぶ。[罠](command:workbench.action.reloadWindow)']]),
  );
  assert.equal(
    translated,
    ['    handlers[name](event);', '', 'イベントの[ハンドラー](https://example.com/handler)を呼ぶ。罠', '', '```ts', 'run(<a:b>);', '```'].join('\n'),
  );
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
