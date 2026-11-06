import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  commentContent,
  displayWidth,
  layoutInline,
  locateBlocks,
  packText,
  toPlainText,
  truncateWidth,
} from '../../src/core/inlineLayout.ts';
import { normalize } from '../../src/core/normalize.ts';
import { extractComments } from './helpers.ts';

async function setup(source: string, file = 'a.ts') {
  const lines = source.split('\n');
  const units = normalize(await extractComments(file, source), { targetLang: 'ja' }).filter((u) => !u.skip);
  return { units, lineAt: (l: number) => lines[l] ?? '' };
}

test('commentContent: コメント記号を除く', () => {
  assert.equal(commentContent('  // text here'), 'text here');
  assert.equal(commentContent(' * @param x - The value.'), '@param x - The value.');
  assert.equal(commentContent('/** Summary. */'), 'Summary.');
  assert.equal(commentContent('    """Docstring."""'), 'Docstring.');
  assert.equal(commentContent(' *'), '');
});

test('locateBlocks: 段落ごとに、始まる行と続きの行を見つける', async () => {
  const { units, lineAt } = await setup(
    [
      '/**', //                              0
      ' * Parses the file and returns', //   1
      ' * the result.', //                   2
      ' *', //                               3
      ' * @param path - Absolute path.', //  4
      ' * @example', //                      5
      ' * parse("x")', //                    6
      ' */', //                              7
      'function parse(path) {}', //          8
    ].join('\n'),
  );
  const unit = units[0]!;
  const located = locateBlocks(unit, lineAt);
  assert.deepEqual([...located.values()], [[1, 2], [4]]);
});

test('displayWidth / truncateWidth: 全角は2桁として数える', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('日本語'), 6);
  assert.equal(displayWidth('a、b'), 4);
  assert.equal(truncateWidth('日本語のテキスト', 9), '日本語の…');
  assert.equal(truncateWidth('short', 9), 'short');
});

test('toPlainText: 行末の装飾では Markdown の記号を外す', () => {
  assert.equal(
    toPlainText('`logger.warn()` で警告する。{@link loadDefaults} と {@link Foo | 既定値} と [資料](https://x) を参照。'),
    'logger.warn() で警告する。loadDefaults と 既定値 と 資料 を参照。',
  );
});

test('packText: 文と読点で区切って行に詰め、入りきらなければ省略する（幅は表示幅）', () => {
  const w = (n: number, width: number) => Array<number>(n).fill(width);
  assert.deepEqual(packText('一文目です。二文目です。', w(2, 40)), ['一文目です。', '二文目です。']);
  // 行が1つなら1行にまとめる
  assert.deepEqual(packText('短い。とても短い。', w(1, 40)), ['短い。とても短い。']);
  // 文の数より行が多ければ、余った行は使わない
  assert.deepEqual(packText('一文だけ。', w(3, 40)), ['一文だけ。']);
  // 行数が足りなければ最後の行で省略
  assert.deepEqual(packText('一文目です。二文目です。三文目です。', w(2, 16)), ['一文目です。', '二文目です。三…']);
  // 長い文は読点で区切る
  assert.deepEqual(packText('とても長い文なので、読点のところで区切って、複数行に分ける。', w(3, 24)), [
    'とても長い文なので、',
    '読点のところで区切って、',
    '複数行に分ける。',
  ]);
  // 行ごとに使える幅が違う
  assert.deepEqual(packText('一文目です。二文目です。', [8, 40]), ['一文目…', '二文目です。']);
  assert.deepEqual(packText('One sentence. Another one.', w(2, 15)), ['One sentence.', 'Another one.']);
  // 区切りのない長い英文は単語の境目で区切る
  assert.deepEqual(packText('a very long sentence without any commas at all', w(3, 20)), [
    'a very long sentence',
    'without any commas',
    'at all',
  ]);
  assert.deepEqual(packText('', w(2, 10)), []);
});

test('layoutInline: 訳文がある段落だけを、元の行の右に並べる', async () => {
  const { units, lineAt } = await setup(
    [
      '/*', //                           0
      ' * First paragraph that is', //   1
      ' * wrapped over two lines.', //   2
      ' *', //                           3
      ' * Second paragraph.', //         4
      ' */', //                          5
      'f();', //                         6
    ].join('\n'),
  );
  const unit = units[0]!;
  const proseIndexes = unit.blocks.flatMap((b, i) => (b.type === 'prose' ? [i] : []));
  assert.equal(proseIndexes.length, 2);
  const translations = new Map([
    [proseIndexes[0]!, '最初の段落。二行にわたる。'],
    // 2つ目の段落はまだ訳されていない
  ]);
  assert.deepEqual(layoutInline(unit, translations, lineAt, 30 + 16), [
    { line: 1, text: '最初の段落。' },
    { line: 2, text: '二行にわたる。' },
  ]);
  translations.set(proseIndexes[1]!, '二つ目の段落。');
  assert.deepEqual(layoutInline(unit, translations, lineAt, 120).at(-1), { line: 4, text: '二つ目の段落。' });
});
