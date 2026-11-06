/**
 * 原文から「訳さずに残すべきトークン」（識別子、インラインコード、URL など）を拾い、
 * PFML3 の glossary（原語 = 訳語）として渡す。あわせて、訳文に残ったかを数える評価用関数も持つ。
 */
import type { GlossaryEntry } from './pfml3.ts';

// 先に書いたパターンが優先。範囲が重なる後続のマッチ（URL の中の "example.com" など）は捨てる
// 1番目のキャプチャがあればそれを、なければマッチ全体をトークンにする
const PATTERNS: readonly RegExp[] = [
  /(?<!`)(?:`{1,2})(?!`)([^`\n]+?)(?<!`)(?:`{1,2})(?!`)/g, // `code` / ``code``（RST）。中身だけを使う
  /\]\((https?:\/\/[^\s)]+)\)/g, // Markdown リンク先
  /\{@link[^}]*\}/g, // TSDoc / JSDoc のリンク
  /https?:\/\/[^\s)>\]]+/g, // URL
  /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?/g, // a.b.c / a.b()
  /\b[A-Za-z_$][\w$]*\(\)/g, // foo()
  /\b[a-z]+[A-Z][\w$]*\b/g, // camelCase
  /\b[A-Z][a-z0-9]+[A-Z][\w$]*\b/g, // PascalCase（内部に大文字があるもの）
  /\b[A-Za-z][A-Za-z0-9]*_[\w]+\b/g, // snake_case / SCREAMING_CASE
];

/** 識別子っぽく見えるが一般的な表記なので除外する */
const IGNORE = /^(?:e\.g|i\.e|etc|vs|a\.k\.a)\.?$/i;

export function extractProtectedTokens(text: string, max = 20): string[] {
  const found = new Set<string>();
  const claimed: Array<[number, number]> = [];
  for (const re of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (claimed.some(([s, e]) => start < e && end > s)) continue;
      claimed.push([start, end]);
      const tok = (m[1] ?? m[0]).replace(/[.,;:]+$/, '');
      if (tok.length < 3 || IGNORE.test(tok)) continue;
      found.add(tok);
    }
  }
  // 長いものを優先（`foo.bar()` を `foo` より先に）
  return [...found].sort((a, b) => b.length - a.length).slice(0, max);
}

export function buildGlossary(text: string): GlossaryEntry[] {
  return extractProtectedTokens(text).map((t) => ({ source: t, target: t }));
}

/** 保護対象トークンとバッククォートを取り除いた文章部分（出力言語の判定用） */
export function stripProtected(text: string): string {
  let out = text;
  for (const tok of extractProtectedTokens(text, Number.POSITIVE_INFINITY)) out = out.split(tok).join(' ');
  return out.replace(/`+/g, ' ');
}

/** 原文中の保護対象トークンのうち、訳文にそのまま残った数 */
export function countPreserved(source: string, output: string): { total: number; kept: number } {
  const tokens = extractProtectedTokens(source, Number.POSITIVE_INFINITY);
  return { total: tokens.length, kept: tokens.filter((t) => output.includes(t)).length };
}
