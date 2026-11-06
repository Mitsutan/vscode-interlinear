import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toHoverMarkdown } from '../../src/editor/markdown.ts';

const NBSP = ' ';

test('改行を保ち、doctest と見出し記号をエスケープする', () => {
  assert.equal(
    toHoverMarkdown('一行目\n二行目\n\n>>> f()\n# 見出しではない'),
    ['一行目  ', '二行目  ', '', '\\>>> f()  ', '\\# 見出しではない  '].join('\n'),
  );
});

test('行頭のインデントはコードブロックにならないよう NBSP にする', () => {
  assert.equal(toHoverMarkdown('Args:\n    rate (float): 毎秒のトークン数'), `Args:  \n${NBSP.repeat(4)}rate (float): 毎秒のトークン数  `);
});

test('コードフェンスの中は変えない', () => {
  const src = '例:\n```js\n    # not a heading\n> x\n```\n後';
  assert.equal(toHoverMarkdown(src), '例:  \n```js\n    # not a heading\n> x\n```\n後  ');
});
