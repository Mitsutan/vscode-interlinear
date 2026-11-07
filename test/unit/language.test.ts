import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultTargetLanguage } from '../../src/core/language.ts';

test('出力言語の既定値は、表示言語が日本語なら ja', () => {
  assert.equal(defaultTargetLanguage('ja'), 'ja');
});

test('出力言語の既定値は、表示言語が英語なら en（地域付きでも）', () => {
  assert.equal(defaultTargetLanguage('en'), 'en');
  assert.equal(defaultTargetLanguage('en-US'), 'en');
});

test('出力言語の既定値は、表示言語が日本語・英語以外なら en', () => {
  assert.equal(defaultTargetLanguage('zh-cn'), 'en');
  assert.equal(defaultTargetLanguage('de'), 'en');
  assert.equal(defaultTargetLanguage(''), 'en');
});
