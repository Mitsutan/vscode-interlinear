import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import * as l10n from '@vscode/l10n';
import TreeSitter from '@vscode/tree-sitter-wasm';
import type { Node } from '@vscode/tree-sitter-wasm';
import { nodeWasmDir } from '../../src/core/node-wasm.ts';
import { LLAMA_ASSETS, llamaIncompatibility } from '../../src/managed/manifest.ts';

const root = path.resolve(import.meta.dirname, '../..');
const readJson = async (file: string) => JSON.parse(await readFile(path.join(root, file), 'utf8')) as Record<string, unknown>;

interface Call {
  where: string;
  message: string;
  args: number;
}

async function parseSources(): Promise<Array<{ file: string; tree: Node }>> {
  const wasmDir = nodeWasmDir();
  await TreeSitter.Parser.init({ locateFile: (file: string) => path.join(wasmDir, file) });
  const language = await TreeSitter.Language.load(new Uint8Array(await readFile(path.join(wasmDir, 'tree-sitter-typescript.wasm'))));
  const parser = new TreeSitter.Parser();
  parser.setLanguage(language);
  const files = (await readdir(path.join(root, 'src'), { recursive: true })).filter((f) => f.endsWith('.ts'));
  return Promise.all(
    files.map(async (file) => ({ file: path.join('src', file), tree: parser.parse(await readFile(path.join(root, 'src', file), 'utf8'))!.rootNode })),
  );
}

function* descendants(node: Node): Generator<Node> {
  yield node;
  for (const child of node.namedChildren) if (child) yield* descendants(child);
}

const ESCAPES: Record<string, string> = { '\\n': '\n', "\\'": "'", '\\"': '"', '\\\\': '\\' };

/** 文字列リテラルの値。テンプレート文字列などは、訳を引くキーにならないので undefined */
function stringValue(node: Node): string | undefined {
  if (node.type !== 'string') return undefined;
  return node.namedChildren
    .map((part) => {
      if (part?.type === 'escape_sequence') {
        const v = ESCAPES[part.text];
        if (v === undefined) throw new Error(`unsupported escape ${part.text}`);
        return v;
      }
      return part?.text ?? '';
    })
    .join('');
}

const sources = parseSources();

/** vscode.l10n.t(...) と、@vscode/l10n の l10n.t(...) の呼び出し */
async function l10nCalls(): Promise<Call[]> {
  const calls: Call[] = [];
  for (const { file, tree } of await sources) {
    for (const node of descendants(tree)) {
      const fn = node.type === 'call_expression' ? node.childForFieldName('function') : null;
      if (fn?.type !== 'member_expression' || fn.childForFieldName('property')?.text !== 't') continue;
      if (!/(^|\.)l10n$/.test(fn.childForFieldName('object')?.text ?? '')) continue;
      const [first, ...rest] = node.childForFieldName('arguments')?.namedChildren ?? [];
      const where = `${file}:${node.startPosition.row + 1}`;
      const message = first ? stringValue(first) : undefined;
      assert.ok(message !== undefined, `${where}: l10n.t の最初の引数は文字列リテラルにする（訳を引くキーになるため）`);
      calls.push({ where, message, args: rest.length });
    }
  }
  return calls;
}

const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1])))].sort();

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

test('画面に出す文言の原文は英語で書く（日本語は l10n/bundle.l10n.ja.json に書く）', async () => {
  const found: string[] = [];
  for (const { file, tree } of await sources) {
    for (const node of descendants(tree)) {
      if ((node.type === 'string' || node.type === 'template_string') && JAPANESE.test(node.text)) {
        found.push(`${file}:${node.startPosition.row + 1}: ${node.text}`);
      }
    }
  }
  assert.deepEqual(found, []);
});

test('l10n.t の文言には、すべて日本語訳がある（使っていない訳も残さない）', async () => {
  const bundle = await readJson('l10n/bundle.l10n.ja.json');
  const used = new Set((await l10nCalls()).map((c) => c.message));
  assert.deepEqual([...used].filter((m) => !(m in bundle)), [], '訳がない');
  assert.deepEqual(Object.keys(bundle).filter((m) => !used.has(m)), [], '使っていない訳');
});

test('l10n.t の引数の数と、原文・訳文の {0} などの数が一致する', async () => {
  const bundle = await readJson('l10n/bundle.l10n.ja.json');
  for (const { where, message, args } of await l10nCalls()) {
    const expected = Array.from({ length: args }, (_, i) => i);
    assert.deepEqual(placeholders(message), expected, `${where}: 原文 "${message}"`);
    const translated = bundle[message];
    if (typeof translated === 'string') assert.deepEqual(placeholders(translated), expected, `${where}: 訳文 "${translated}"`);
  }
});

test('日本語の訳を読み込むと、vscode に依存しない層のメッセージも日本語になる', async () => {
  l10n.config({ contents: (await readJson('l10n/bundle.l10n.ja.json')) as l10n.l10nJsonFormat });
  const linux = { ...LLAMA_ASSETS['linux-arm64']!, minGlibc: '2.38' };
  assert.equal(llamaIncompatibility(linux, '2.36'), '自動で入れる llama.cpp には glibc 2.38 以上が必要です（この環境は 2.36）');
});

test('package.json の %キー% には、英語（package.nls.json）と日本語（package.nls.ja.json）の文言がある', async () => {
  const manifest = await readJson('package.json');
  const used = new Set<string>();
  const collect = (v: unknown): void => {
    if (typeof v === 'string') {
      const m = /^%(.+)%$/.exec(v);
      if (m) used.add(m[1]!);
    } else if (v && typeof v === 'object') {
      for (const child of Object.values(v)) collect(child);
    }
  };
  collect(manifest);
  const en = Object.keys(await readJson('package.nls.json'));
  const ja = Object.keys(await readJson('package.nls.ja.json'));
  assert.deepEqual(en.toSorted(), [...used].sort(), 'package.nls.json');
  assert.deepEqual(ja.toSorted(), [...used].sort(), 'package.nls.ja.json');
});
