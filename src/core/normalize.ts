/**
 * 抽出したコメントを「翻訳単位」に正規化する。
 *  1. 連続する行コメントを1ブロックにまとめる（行末コメントや、種類の違う行はまとめない）
 *  2. コメント記号を取り除く
 *  3. 本文を prose（翻訳する）と verbatim（そのまま残す）のブロックに分ける
 *  4. 翻訳不要なもの（ディレクティブ、コメントアウトされたコードなど）に除外理由を付ける
 */
import path from 'node:path';
import type { RawComment } from './extract.ts';

export type Block =
  | { type: 'verbatim'; text: string }
  | { type: 'prose'; prefix: string; text: string };

export type SkipReason =
  | 'directive'
  | 'license'
  | 'code'
  | 'decorative'
  | 'already-target'
  | 'too-short'
  | 'no-prose';

export type UnitKind = 'line' | 'trailing' | 'block' | 'doc' | 'docstring';

export interface TranslationUnit {
  id: string;
  file: string;
  languageId: string;
  kind: UnitKind;
  /** 0 始まり。列は UTF-16 コード単位 */
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  raw: string;
  /** コメント記号を除いた本文 */
  body: string;
  blocks: Block[];
  codeLine?: string;
  skip?: SkipReason;
}

// ---------------------------------------------------------------------------
// 行の分類

const DIRECTIVE =
  /^(?:eslint(?:-disable|-enable)?\b|prettier-ignore|tslint:|jshint\b|istanbul ignore|[cv]8 ignore|@ts-(?:ignore|expect-error|nocheck|check)\b|biome-ignore|deno-lint-ignore|noqa\b|type:\s*ignore|pylint:|mypy:|pyright:|fmt:\s*(?:on|off|skip)|isort:|pragma\b|nolint|NOLINT|go:\w+|\+build\b|#?(?:end)?region\b|-\*-.*-\*-|!\/|<reference\s|NOSONAR|clang-format|rubocop:|frozen_string_literal|shellcheck\b)/i;

const CODE_KEYWORD =
  /^(?:import|export|const|let|var|function|return|if|else|for|while|switch|case|break|continue|throw|try|catch|await|async|def|class|from|elif|print|raise|yield|lambda|pass|fn|pub|impl|use|func|package)\b/;

export type LineClass = 'directive' | 'code' | 'prose';

export function classifyLine(line: string): LineClass {
  const t = line.trim();
  if (DIRECTIVE.test(t)) return 'directive';
  if (t === '') return 'prose';
  if (/[;{}]\s*$/.test(t)) return 'code';
  if (/^[})\]]/.test(t)) return 'code';
  if (CODE_KEYWORD.test(t) && /[(){}=;[\]]/.test(t)) return 'code';
  if (/^(?:def|class|if|elif|else|for|while|try|except|finally|with)\b.*:$/.test(t)) return 'code';
  if (/^[\w$.]+(?:\[[^\]]*\])?\s*(?:=|\+=|-=|===?|=>)\s*\S/.test(t) && !/[.!?]$/.test(t)) return 'code';
  if (/^[\w$.]+\([^)]*\)\s*;?$/.test(t)) return 'code';
  return 'prose';
}

// ---------------------------------------------------------------------------
// コメント記号の除去

const LINE_MARKER = /^\s*(?:\/\/[/!]?|#+)\s?/;

function stripLineMarker(line: string): string {
  return line.replace(LINE_MARKER, '');
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim() !== '').map((l) => /^\s*/.exec(l)![0].length);
  const min = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min));
}

function trimBlankLines(lines: string[]): string[] {
  let s = 0;
  let e = lines.length;
  while (s < e && lines[s]!.trim() === '') s++;
  while (e > s && lines[e - 1]!.trim() === '') e--;
  return lines.slice(s, e);
}

function stripBlock(text: string): string {
  const inner = text.replace(/^\/\*+!?/, '').replace(/\*+\/$/, '');
  const lines = inner.split(/\r?\n/).map((l) => l.replace(/^\s*\*(?!\/)\s?/, ''));
  return trimBlankLines(dedent(lines)).join('\n');
}

/** Python の inspect.cleandoc 相当 */
function stripDocstring(text: string): string {
  const m = /^[rRuUbBfF]*("""|'''|"|')([\s\S]*)\1$/.exec(text);
  const inner = m ? m[2]! : text;
  const [first = '', ...rest] = inner.split(/\r?\n/);
  return trimBlankLines([first.trim(), ...dedent(rest)]).join('\n');
}

// ---------------------------------------------------------------------------
// prose / verbatim ブロックへの分割

/**
 * JSDoc の型 `{...}`。`{{ error: boolean }}` のような入れ子の波かっこは 3 段まで対応する。
 * 正規表現では任意の深さを数えられないので、それより深い型や、行をまたぐ型は型として認識しない。
 */
const TYPE = String.raw`\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}`;
/** タグ名 + 型 + 名前 の後ろに説明文が続くタグ */
const NAMED_TAG = new RegExp(
  String.raw`^(@(?:param|arg|argument|property|prop|template|typeParam|typeparam)\b(?:\s+${TYPE})?\s+(?:\[[^\]]*\]|[\w$.]+)(?:\s+-)?)\s*(.*)$`,
);
/**
 * タグ名（+ 型）の後ろに説明文が続くタグ。
 * 型は省略できるが、`{` で始まるのに型として認識できないときは一致させない。
 * 一致させると、型の一部が説明文として翻訳に回ってしまう。
 */
const PROSE_TAG = new RegExp(
  String.raw`^(@(?:returns?|throws|exception|deprecated|remarks|summary|description|note|todo|privateRemarks|yields?)\b(?:\s+${TYPE}|(?!\s+\{))(?:\s+-)?)\s*(.*)$`,
);
const GOOGLE_SECTION =
  /^(?:Args|Arguments|Parameters|Params|Returns|Return|Yields|Raises|Attributes|Example|Examples|Note|Notes|See Also|Warns|Warnings|Other Parameters|Keyword Args|Keyword Arguments|Methods|References|Todo):\s*$/;
const GOOGLE_ITEM = /^(\s+[\w*.]+(?:\s*\([^)]*\))?:)\s+(.+)$/;
const LIST_ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)(.+)$/;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function looksLikeCode(t: string): boolean {
  if (/^[\w$.]+\s*\(.*\)\s*(?:->|=>|:)\s*\S/.test(t)) return true; // f(x) -> T / f(x): T
  if (classifyLine(t) === 'code') return true;
  // "-- Public interface -----" のような見出しの飾りは比率の計算から除く
  const visible = t.replace(/([-=*#~_])\1+/g, '').replace(/\s/g, '');
  const letters = visible.match(/\p{L}/gu)?.length ?? 0;
  return visible.length >= 6 && letters / visible.length < 0.6;
}

/** 段落内の改行を連結する（日本語・中国語・韓国語の境目には空白を入れない） */
export function joinLine(a: string, b: string): string {
  if (a === '') return b;
  if (CJK.test(a.at(-1) ?? '') || CJK.test(b[0] ?? '')) return a + b;
  return `${a} ${b}`;
}

export function toBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let open: Extract<Block, { type: 'prose' }> | undefined;
  let mode: 'normal' | 'fence' | 'example' | 'verbatim-tag' | 'doctest' | 'section' = 'normal';
  let fence = '';

  const verbatim = (text: string) => {
    open = undefined;
    blocks.push({ type: 'verbatim', text });
  };
  const prose = (prefix: string, text: string) => {
    open = { type: 'prose', prefix, text };
    blocks.push(open);
  };

  for (const line of body.split('\n')) {
    const t = line.trim();

    if (mode === 'fence') {
      verbatim(line);
      if (t.startsWith(fence)) mode = 'normal';
      continue;
    }
    const fenceStart = /^(`{3,}|~{3,})/.exec(t);
    if (fenceStart) {
      verbatim(line);
      fence = fenceStart[1]!;
      mode = 'fence';
      continue;
    }
    if (t === '') {
      verbatim('');
      if (mode === 'doctest' || mode === 'section') mode = 'normal';
      continue;
    }
    if (t.startsWith('>>>')) {
      verbatim(line);
      mode = 'doctest';
      continue;
    }
    if (mode === 'doctest') {
      verbatim(line);
      continue;
    }

    if (t.startsWith('@')) {
      mode = 'normal';
      if (/^@example\b/.test(t)) {
        verbatim(line);
        mode = 'example';
        continue;
      }
      const m = NAMED_TAG.exec(t) ?? PROSE_TAG.exec(t);
      if (m) {
        prose(`${m[1]} `, m[2] ?? '');
        continue;
      }
      verbatim(line);
      mode = 'verbatim-tag';
      continue;
    }
    if (mode === 'example' || mode === 'verbatim-tag') {
      verbatim(line);
      continue;
    }

    // 飾り線（文字を含まない行）は verbatim。"-----" は NumPy スタイルの見出し下線も兼ねる
    if (!/\p{L}/u.test(t)) {
      verbatim(line);
      if (/^[-=]{3,}$/.test(t)) mode = 'section';
      continue;
    }
    if (GOOGLE_SECTION.test(t)) {
      verbatim(line);
      mode = 'section';
      continue;
    }
    if (mode === 'section') {
      const item = GOOGLE_ITEM.exec(line);
      if (item) {
        prose(`${item[1]} `, item[2]!);
        continue;
      }
    }
    const li = LIST_ITEM.exec(line);
    if (li) {
      prose(li[1]!, li[2]!);
      continue;
    }
    if (open) {
      open.text = joinLine(open.text, t);
      continue;
    }
    // 段落の先頭に来たシグネチャ行・コード行・記号の多い表の行は訳さない
    if (looksLikeCode(t)) {
      verbatim(line);
      continue;
    }
    prose(/^\s*/.exec(line)![0], t);
  }

  // 説明文が空のタグ（例: 単独の "@returns"）は verbatim に戻す
  return blocks.map((b) =>
    b.type === 'prose' && b.text.trim() === '' ? { type: 'verbatim', text: b.prefix.trimEnd() } : b,
  );
}

export function reassemble(blocks: readonly Block[], translations: ReadonlyMap<number, string>): string {
  return blocks
    .map((b, i) => (b.type === 'verbatim' ? b.text : b.prefix + (translations.get(i) ?? b.text)))
    .join('\n');
}

// ---------------------------------------------------------------------------
// 除外判定

function scriptRatio(text: string, script: RegExp): number {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return 0;
  return (text.match(script)?.length ?? 0) / letters;
}

const SCRIPT_BY_LANG: Record<string, { pattern: RegExp; threshold: number }> = {
  ja: { pattern: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu, threshold: 0.25 },
  zh: { pattern: /\p{Script=Han}/gu, threshold: 0.5 },
  ko: { pattern: /\p{Script=Hangul}/gu, threshold: 0.3 },
  en: { pattern: /[A-Za-z]/g, threshold: 0.95 },
};

/** 出力言語の文字種がどれだけ含まれるか（判定できない言語は undefined） */
export function targetScriptRatio(text: string, targetLang: string): number | undefined {
  const s = SCRIPT_BY_LANG[targetLang];
  return s ? scriptRatio(text, s.pattern) : undefined;
}

export function isInTargetLanguage(text: string, targetLang: string): boolean {
  const s = SCRIPT_BY_LANG[targetLang];
  if (!s) return false;
  // 英語は「英字以外がほぼない」ことで判定するので、日本語混じりの文を誤って除外しない
  return scriptRatio(text, s.pattern) >= s.threshold;
}

function classify(unit: TranslationUnit, lineClasses: readonly LineClass[], targetLang: string): SkipReason | undefined {
  const body = unit.body;
  if (!/\p{L}/u.test(body)) return 'decorative';
  if (lineClasses.length > 0 && lineClasses.every((c) => c === 'directive')) return 'directive';
  if (DIRECTIVE.test(body.trim())) return 'directive';
  if (unit.startLine <= 2 && /copyright|spdx-license-identifier|licensed under|all rights reserved/i.test(body)) {
    return 'license';
  }
  if (unit.kind !== 'docstring' && unit.kind !== 'doc') {
    const nonEmpty = body.split('\n').filter((l) => l.trim() !== '');
    const code = nonEmpty.filter((l) => classifyLine(l) === 'code').length;
    if (nonEmpty.length > 0 && code / nonEmpty.length >= 0.6) return 'code';
  }
  const proseText = unit.blocks.flatMap((b) => (b.type === 'prose' ? [b.text] : [])).join('\n');
  if (proseText.trim() === '') return 'no-prose';
  if (isInTargetLanguage(proseText, targetLang)) return 'already-target';
  if ((proseText.match(/\p{L}/gu)?.length ?? 0) < 4) return 'too-short';
  return undefined;
}

// ---------------------------------------------------------------------------

interface Group {
  comments: RawComment[];
  lineClasses: LineClass[];
}

/** 連続する行コメント（同じ桁・行末コメントでない・同じ種類の行）をまとめる */
export function groupLineComments(comments: readonly RawComment[]): Group[] {
  const sorted = [...comments].sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn);
  const groups: Group[] = [];
  for (const c of sorted) {
    const cls = c.kind === 'line' ? classifyLine(stripLineMarker(c.text)) : 'prose';
    const last = groups.at(-1);
    const prev = last?.comments.at(-1);
    if (
      last &&
      prev &&
      c.kind === 'line' &&
      prev.kind === 'line' &&
      !c.trailing &&
      !prev.trailing &&
      c.startLine === prev.endLine + 1 &&
      c.startColumn === prev.startColumn &&
      cls === last.lineClasses.at(-1) &&
      stripLineMarker(c.text).trim() !== ''
    ) {
      last.comments.push(c);
      last.lineClasses.push(cls);
      continue;
    }
    groups.push({ comments: [c], lineClasses: [cls] });
  }
  return groups;
}

/** 位置（0 始まりの行・UTF-16 列）がコメントの範囲内にあるか */
export function containsPosition(unit: TranslationUnit, line: number, character: number): boolean {
  if (line < unit.startLine || line > unit.endLine) return false;
  if (line === unit.startLine && character < unit.startColumn) return false;
  if (line === unit.endLine && character > unit.endColumn) return false;
  return true;
}

/** 範囲が [fromLine, toLine] と重なるか */
export function overlapsLines(unit: TranslationUnit, fromLine: number, toLine: number): boolean {
  return unit.endLine >= fromLine && unit.startLine <= toLine;
}

export interface NormalizeOptions {
  targetLang: string;
  /** id に使う相対パスの基準 */
  baseDir?: string;
}

export function normalize(comments: readonly RawComment[], opts: NormalizeOptions): TranslationUnit[] {
  return groupLineComments(comments).map(({ comments: cs, lineClasses }) => {
    const first = cs[0]!;
    const last = cs.at(-1)!;
    let body: string;
    let kind: UnitKind;
    if (first.kind === 'docstring') {
      body = stripDocstring(first.text);
      kind = 'docstring';
    } else if (first.kind === 'block') {
      body = stripBlock(first.text);
      kind = first.text.startsWith('/**') ? 'doc' : 'block';
    } else {
      body = trimBlankLines(dedent(cs.map((c) => stripLineMarker(c.text)))).join('\n');
      kind = first.trailing ? 'trailing' : first.text.startsWith('///') ? 'doc' : 'line';
    }
    const relative = opts.baseDir ? path.relative(opts.baseDir, first.file) : first.file;
    const rel = relative.startsWith('..') ? path.resolve(first.file) : relative;
    const unit: TranslationUnit = {
      id: `${rel}:${first.startLine + 1}`,
      file: first.file,
      languageId: first.languageId,
      kind,
      startLine: first.startLine,
      startColumn: first.startColumn,
      endLine: last.endLine,
      endColumn: last.endColumn,
      raw: cs.map((c) => c.text).join('\n'),
      body,
      blocks: toBlocks(body),
      codeLine: last.codeLine,
    };
    unit.skip = classify(unit, first.kind === 'line' ? lineClasses : [], opts.targetLang);
    return unit;
  });
}
