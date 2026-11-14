import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reassemble } from '../../src/core/normalize.ts';
import { hasProse, renderTranslation, restoreLinks, segmentMarkdown } from '../../src/core/markdownBlocks.ts';

// VS Code の TypeScript 拡張が返すホバーの形式
const TS_HOVER = [
  '```typescript',
  'function loadConfig(path: string, options?: LoadOptions): Config',
  '```',
  'Loads the settings stored at `path`.',
  '',
  'For details, see [parseConfig](command:_typescript.openJsDocLink?%5B%7B%22file%22%3A1%7D%5D) and',
  'the [guide](https://example.com/config.html "Config guide").',
  '',
  '*@param* `path` — location of the settings file',
  '',
  '*@param* `options`  ',
  'Options that span',
  'multiple lines.',
  '',
  '*@since* — v0.1.8',
  '',
  '*@example*  ',
  '```js',
  "loadConfig('/etc/app.json');",
  '```',
].join('\n');

const prose = (seg: ReturnType<typeof segmentMarkdown>) =>
  seg.blocks.flatMap((b) => (b.type === 'prose' ? [[b.prefix, b.text]] : []));

test('TypeScript のホバー: 文章とタグの説明だけを訳し、シグネチャは訳文に入れない', () => {
  const seg = segmentMarkdown(TS_HOVER, 'ja');
  assert.equal(seg.signature, 'function loadConfig(path: string, options?: LoadOptions): Config');
  assert.deepEqual(prose(seg), [
    ['', 'Loads the settings stored at `path`.'],
    ['', 'For details, see [parseConfig](L0) and the [guide](L1).'],
    ['*@param* `path` — ', 'location of the settings file'],
    ['*@param* `options` ', 'Options that span multiple lines.'],
  ]);
  assert.deepEqual(seg.links, [
    'command:_typescript.openJsDocLink?%5B%7B%22file%22%3A1%7D%5D',
    'https://example.com/config.html "Config guide"',
  ]);
  // @since は文章がほとんどないので訳さない。@example のコードは元の形のまま残す
  const text = reassemble(seg.blocks, new Map());
  assert.match(text, /\*@since\* — v0\.1\.8/);
  assert.doesNotMatch(text, /function loadConfig/);
  assert.ok(text.endsWith("*@example*  \n```js\nloadConfig('/etc/app.json');\n```"), text);
});

// gopls が返すホバーの形式（go/doc/comment の Markdown 出力）。段落は1行、コードはタブで字下げする
const GO_HOVER = [
  '```go',
  'package units',
  '```',
  '',
  '---',
  '',
  'Package units converts lengths between metric and imperial units.',
  '',
  '### Length',
  '',
  'Use [ToFeet] and [ToMeters] for single values.',
  '',
  '\tft := units.ToFeet(3.5)',
  '\tm := units.ToMeters(ft)',
  '',
  'Very large values may lose precision:',
  '',
  '\tbig := 1e18 // farther than any real trip',
  '\tft := units.ToFeet(big)',
  '',
  '\tfmt.Println(ft)',
  '',
  '[Round] and [Truncate] adjust the precision of the results.',
].join('\n');

test('Go のホバー: 字下げのコードは訳さず、行も字下げも元のまま残す', () => {
  const seg = segmentMarkdown(GO_HOVER, 'ja');
  assert.equal(seg.signature, 'package units');
  assert.deepEqual(prose(seg), [
    ['', 'Package units converts lengths between metric and imperial units.'],
    ['### ', 'Length'],
    ['', 'Use [ToFeet] and [ToMeters] for single values.'],
    ['', 'Very large values may lose precision:'],
    ['', '[Round] and [Truncate] adjust the precision of the results.'],
  ]);
  const text = reassemble(seg.blocks, new Map());
  assert.ok(text.startsWith('Package units converts'), text);
  assert.ok(text.includes('\n\n\tft := units.ToFeet(3.5)\n\tm := units.ToMeters(ft)\n\n'), text);
  // コードの中の空行も残す
  assert.ok(text.includes('\n\tbig := 1e18 // farther than any real trip\n\tft := units.ToFeet(big)\n\n\tfmt.Println(ft)\n'), text);
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
  // Ruby の言語サーバーは RDoc をそのまま返す。コード例の 3 行目の "# ..." は、原文のホバーでも段落の一部として表示される
  const rdoc = [
    '=== Read settings',
    '',
    '  require "settings"',
    "  port = conf['port']   # <== value of 'port'",
    "    # if 'port' is missing, then returns nil.",
    '  names = conf.keys     # <== list of setting names',
    '',
    "  # returns true if 'port' is set",
  ].join('\n');
  assert.deepEqual(prose(segmentMarkdown(rdoc, 'ja')), [
    ['', '=== Read settings'],
    [
      '  ',
      `require "settings" port = conf['port']   # <== value of 'port' # if 'port' is missing, then returns nil. names = conf.keys     # <== list of setting names`,
    ],
    // 字下げが 3 桁までなら、空行の後の "# ..." は原文でも見出しになる
    ['  # ', "returns true if 'port' is set"],
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

test('setext の見出しは見出しとして訳し、下線と、その後ろのコード例は元の形のまま残す', () => {
  const seg = segmentMarkdown(
    ['```ts', 'function format(value: number): string', '```', '', 'Formats the value for display.', '', 'Examples', '--------', '', '```ts', 'format(1.5);', '```'].join('\n'),
    'ja',
  );
  // 下線を区切り線と見なすと、後ろのコード例がシグネチャになって訳文から消える
  assert.equal(seg.signature, 'function format(value: number): string');
  assert.deepEqual(prose(seg), [
    ['', 'Formats the value for display.'],
    ['', 'Examples'],
  ]);
  assert.equal(reassemble(seg.blocks, new Map()), 'Formats the value for display.\n\nExamples\n--------\n\n```ts\nformat(1.5);\n```');
});

test('行頭に | のない表は、訳さずに元の形のまま残す', () => {
  const table = ['mode | meaning', '---- | -------', 'r    | open for reading', 'w    | open for writing'].join('\n');
  const seg = segmentMarkdown(`Opens the file in one of these modes:\n\n${table}\n\nThe default mode is r.`, 'ja');
  assert.deepEqual(prose(seg), [
    ['', 'Opens the file in one of these modes:'],
    ['', 'The default mode is r.'],
  ]);
  assert.ok(reassemble(seg.blocks, new Map()).includes(`\n\n${table}\n\n`));
});

test('複数行の HTML ブロックは元の形のまま残し、空行で区切られた Markdown の段落は訳す', () => {
  const details = ['<details>', '<summary>Supported keys</summary>', 'port and host are read from the file', '</details>'].join('\n');
  const seg = segmentMarkdown(['Reads the settings.', '', details, '', '<div>', '', 'Markdown text inside the block.', '', '</div>'].join('\n'), 'ja');
  assert.deepEqual(prose(seg), [
    ['', 'Reads the settings.'],
    ['', 'Markdown text inside the block.'],
  ]);
  assert.ok(reassemble(seg.blocks, new Map()).includes(`\n\n${details}\n\n`));
});

test('引用やリストの中の段落は、原文の記号と字下げを prefix にして訳す', () => {
  const seg = segmentMarkdown(
    [
      '> Note: the cache is',
      '> cleared on restart.',
      'Lazy lines continue the quote.',
      '',
      '- [ ] Pending task item',
      '- Tight item that',
      '  spans two lines',
      // 項目の中では、1 以外の番号でもリストが始まる（段落の途中では始まらない）
      '  2. Nested numbered item',
      '- Item with a quote',
      '  > Quoted inside the item.',
      '- Item with a tab',
      '',
      '\tContinued after a tab.',
    ].join('\n'),
    'ja',
  );
  assert.deepEqual(prose(seg), [
    ['> ', 'Note: the cache is cleared on restart. Lazy lines continue the quote.'],
    ['- [ ] ', 'Pending task item'],
    ['- ', 'Tight item that spans two lines'],
    ['  2. ', 'Nested numbered item'],
    ['- ', 'Item with a quote'],
    ['  > ', 'Quoted inside the item.'],
    ['- ', 'Item with a tab'],
    ['\t', 'Continued after a tab.'],
  ]);
});

test('改行が CRLF でも行を正しく分け、タブで字下げしたコードはタブのまま残す', () => {
  const seg = segmentMarkdown('Use it like this:\r\n\r\n\tvalue := parse(input)\r\n\r\nThen check the error.', 'ja');
  assert.deepEqual(prose(seg), [
    ['', 'Use it like this:'],
    ['', 'Then check the error.'],
  ]);
  assert.equal(reassemble(seg.blocks, new Map()), 'Use it like this:\n\n\tvalue := parse(input)\n\nThen check the error.');
});

test('原文の行に当てはめられないリスト項目は、訳さずに原文のまま残す', () => {
  // 項目の文章に、空行を挟む字下げのコードが続く形。marked がつないだ結果を原文の行に戻せない
  const first = ['- Item whose text', '      runs into code', '', '      more code', '  and continues'].join('\n');
  const seg = segmentMarkdown(`${first}\n- Second item here`, 'ja');
  assert.deepEqual(prose(seg), [['- ', 'Second item here']]);
  assert.ok(reassemble(seg.blocks, new Map()).startsWith(`${first}\n`));
});

// rust-analyzer が返すホバーの形式。モジュールのパスとシグネチャのコードブロックの後に、区切り線と本文が続く
test('Rust のホバー: 見出しとリンク定義を含む本文を、行の位置をずらさずに分ける', () => {
  const definition = '[`to_meters`]: https://example.com/geometry/units/fn.to_meters.html';
  const seg = segmentMarkdown(
    [
      '```rust',
      'geometry::units',
      '```',
      '',
      '```rust',
      'pub fn to_feet(meters: f64) -> f64',
      '```',
      '',
      '---',
      '',
      'Converts a length in meters to feet.',
      '',
      '# Examples',
      '',
      '```rust',
      'let feet = to_feet(2.0);',
      '```',
      '',
      'See [`to_meters`] for the opposite conversion.',
      '',
      definition,
    ].join('\n'),
    'ja',
  );
  assert.equal(seg.signature, 'geometry::units');
  assert.deepEqual(prose(seg), [
    ['', 'Converts a length in meters to feet.'],
    ['# ', 'Examples'],
    ['', 'See [`to_meters`] for the opposite conversion.'],
  ]);
  const text = reassemble(seg.blocks, new Map());
  assert.doesNotMatch(text, /pub fn to_feet/);
  assert.ok(text.endsWith(`\n\n\`\`\`rust\nlet feet = to_feet(2.0);\n\`\`\`\n\nSee [\`to_meters\`] for the opposite conversion.\n\n${definition}`), text);
});

// Pylance（pyright）が返すホバーの形式。docstring の改行は行末の空白 2 つ、字下げは &nbsp; で表す
test('Python のホバー: 強制改行でつながった行は 1 つの段落として訳し、doctest のコードは残す', () => {
  const doctest = ['```', '>>> parse_size("2 KiB")', '2048', '```'].join('\n');
  const seg = segmentMarkdown(
    [
      '```python',
      '(function) def parse_size(text: str, strict: bool = False) -> int',
      '```',
      '---',
      'Parses a size such as "10 KiB" into bytes.',
      '',
      'Args:  ',
      '&nbsp;&nbsp;text: the size to parse  ',
      '&nbsp;&nbsp;strict: reject unknown units',
      '',
      doctest,
    ].join('\n'),
    'ja',
  );
  assert.equal(seg.signature, '(function) def parse_size(text: str, strict: bool = False) -> int');
  assert.deepEqual(prose(seg), [
    ['', 'Parses a size such as "10 KiB" into bytes.'],
    ['', 'Args: &nbsp;&nbsp;text: the size to parse &nbsp;&nbsp;strict: reject unknown units'],
  ]);
  assert.ok(reassemble(seg.blocks, new Map()).endsWith(`\n\n${doctest}`));
});

// Eclipse JDT LS（jdtls）が返すホバーの形式。Javadoc のタグは入れ子のリストになる
test('Java のホバー: 入れ子のリストの項目を、それぞれの字下げのまま訳す', () => {
  const seg = segmentMarkdown(
    [
      '```java',
      'double com.example.units.Lengths.toFeet(double meters)',
      '```',
      'Converts a length in meters to feet.',
      '',
      '* **Parameters:**',
      '  * **meters** the length to convert',
      '* **Returns:**',
      '  * the length in feet',
    ].join('\n'),
    'ja',
  );
  assert.equal(seg.signature, 'double com.example.units.Lengths.toFeet(double meters)');
  assert.deepEqual(prose(seg), [
    ['', 'Converts a length in meters to feet.'],
    ['* ', '**Parameters:**'],
    ['  * ', '**meters** the length to convert'],
    ['* ', '**Returns:**'],
    ['  * ', 'the length in feet'],
  ]);
});
