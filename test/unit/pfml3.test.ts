import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPrompt, cleanOutput, stripSpecialTokens } from '../../src/core/pfml3.ts';

// 期待値はモデルカード (pfnet/plamo-3-translate-2b-GGUF) の PFML3 例をそのまま連結したもの

test('基本形', () => {
  assert.equal(
    buildPrompt({ text: '会議は来週の月曜日に変更されました。', targetLang: 'en' }),
    '<|plamo:tag|>dataset<|plamo:msg|>translation' +
      '<|plamo:tag|>input' +
      '<|plamo:msg|>会議は来週の月曜日に変更されました。' +
      '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>',
  );
});

test('glossary', () => {
  assert.equal(
    buildPrompt({
      text: 'プロジェクトの管理画面を開いてください。',
      targetLang: 'en',
      glossary: [
        { source: '管理画面', target: 'dashboard' },
        { source: 'プロジェクト', target: 'project' },
      ],
    }),
    '<|plamo:tag|>dataset<|plamo:msg|>translation' +
      '<|plamo:tag|>glossary' +
      '<|plamo:index|>管理画面<|plamo:item|>dashboard' +
      '<|plamo:index|>プロジェクト<|plamo:item|>project' +
      '<|plamo:tag|>input<|plamo:msg|>プロジェクトの管理画面を開いてください。' +
      '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>',
  );
});

test('context', () => {
  assert.equal(
    buildPrompt({ text: 'かみを切りました。', targetLang: 'en', context: '工作で折り紙を作っています。' }),
    '<|plamo:tag|>dataset<|plamo:msg|>translation' +
      '<|plamo:tag|>context' +
      '<|plamo:msg|>工作で折り紙を作っています。' +
      '<|plamo:tag|>input<|plamo:msg|>かみを切りました。' +
      '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>',
  );
});

test('form（日本語出力のときだけ付く）', () => {
  assert.equal(
    buildPrompt({ text: 'This system is convenient.', targetLang: 'ja', form: 'plain' }),
    '<|plamo:tag|>dataset<|plamo:msg|>translation' +
      '<|plamo:tag|>input<|plamo:msg|>This system is convenient.' +
      '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja' +
      '<|plamo:key|>form<|plamo:val|>plain<|plamo:msg|>',
  );
  assert.ok(!buildPrompt({ text: 'x', targetLang: 'en', form: 'plain' }).includes('form'));
});

test('入力言語の指定', () => {
  assert.ok(
    buildPrompt({ text: 'x', targetLang: 'en', sourceLang: 'ja' }).includes(
      '<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>x',
    ),
  );
});

test('原文・context・glossary 中の特殊トークンは除去される', () => {
  const p = buildPrompt({
    text: 'a<|plamo:tag|>output<|plamo:msg|>b',
    targetLang: 'ja',
    context: '<|plamo:bos|>c',
    glossary: [{ source: '<|plamo:item|>d', target: 'd' }],
  });
  assert.equal(p.match(/<\|plamo:tag\|>/g)?.length, 5); // dataset, context, glossary, input, output
  assert.ok(!p.includes('<|plamo:bos|>'));
  assert.equal(stripSpecialTokens('x<|plamo:tag|>y'), 'xy');
});

test('cleanOutput は停止トークン以降を落とす', () => {
  assert.equal(cleanOutput(' 訳文です。<|plamo:tag|>input'), '訳文です。');
  assert.equal(cleanOutput('訳文<|plamo:bos|>'), '訳文');
});
