/**
 * 訳文を、コメントの各行の右側にどう並べるかを決める（行末ゴーストテキスト用）。
 *
 * 段落（prose ブロック）ごとに、その段落が始まる行を元のソースから探し、
 * 段落が複数行にわたるなら、訳文を文や読点で区切ってそれらの行に詰めて並べる。
 */
import { joinLine, type Block } from './normalize.ts';

export interface InlineLine {
  /** 0 始まりの行番号 */
  line: number;
  text: string;
}

export interface InlineTarget {
  blocks: readonly Block[];
  startLine: number;
  endLine: number;
}

/** 行からコメント記号を除いた中身 */
export function commentContent(line: string): string {
  return line
    .trim()
    .replace(/^(?:\/\*\*?|\*(?!\/)|\/\/[/!]?|#+|"""|''')\s?/, '')
    .replace(/\s*(?:\*\/|"""|''')$/, '')
    .trim();
}

/**
 * prose ブロックごとに、元のソースのどの行にあるかを返す。
 * 段落は複数行を連結したものなので、「段落の本文に中身が含まれる行」を続きの行とみなす。
 */
export function locateBlocks(target: InlineTarget, lineAt: (line: number) => string): Map<number, number[]> {
  const result = new Map<number, number[]>();
  let cursor = target.startLine;
  target.blocks.forEach((block, index) => {
    if (block.type !== 'prose' || cursor > target.endLine) return;
    const probe = block.text.slice(0, 16);
    let start = -1;
    for (let l = cursor; l <= target.endLine; l++) {
      if (lineAt(l).includes(probe)) {
        start = l;
        break;
      }
    }
    if (start < 0) start = cursor;
    const lines = [start];
    for (let l = start + 1; l <= target.endLine; l++) {
      const content = commentContent(lineAt(l));
      if (content === '' || !block.text.includes(content)) break;
      lines.push(l);
    }
    result.set(index, lines);
    cursor = lines.at(-1)! + 1;
  });
  return result;
}

const SENTENCE_END = /(?<=[。！？!?])|(?<=\.)(?=\s)/;
const CLAUSE_END = /(?<=[、，,])/;
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
const TAB_SIZE = 4;
/** 訳文の前に付ける「 → 」と余白の分 */
const DECORATION_OVERHEAD = 4;
/** コード行が長くても、訳文に最低限これだけの幅を使う */
const MIN_TEXT_WIDTH = 16;

/** 等幅フォントでの表示幅（全角文字は2桁） */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch === '\t' ? TAB_SIZE : WIDE.test(ch) ? 2 : 1;
  return w;
}

/** 表示幅が width を超える場合は、末尾を「…」にして収める */
export function truncateWidth(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** 表示幅で区切る。空白があれば単語の境目で、なければ（日本語など）文字の境目で区切る */
function sliceByWidth(s: string, width: number): string[] {
  const tokens = /\s/.test(s) ? s.split(/(?<=\s)/) : [...s];
  const out: string[] = [];
  let current = '';
  for (const token of tokens) {
    if (current !== '' && displayWidth((current + token).trimEnd()) > width) {
      out.push(current.trimEnd());
      current = '';
    }
    current += token;
  }
  if (current.trim() !== '') out.push(current.trimEnd());
  return out;
}

/**
 * 行末の装飾は Markdown を描画しないので、コード用の記号を外して読みやすくする。
 * `code` → code、{@link Foo} / {@link Foo | 表示名} → Foo / 表示名、[文字](リンク) → 文字
 */
export function toPlainText(text: string): string {
  return text
    .replace(/\{@link(?:code|plain)?\s+([^}|]+?)(?:\s*\|\s*([^}]+))?\}/g, (_m, target: string, label?: string) => (label ?? target).trim())
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
}

interface Phrase {
  text: string;
  /** 文の始まり（行に余裕があれば改行する位置） */
  sentenceStart: boolean;
}

/** 文 → 読点の順に区切り、それでも長い部分は表示幅で切る */
function phrases(text: string, maxWidth: number): Phrase[] {
  const out: Phrase[] = [];
  for (const sentence of text.split(SENTENCE_END)) {
    const s = sentence.trim();
    if (s === '') continue;
    if (displayWidth(s) <= maxWidth) {
      out.push({ text: s, sentenceStart: true });
      continue;
    }
    let first = true;
    for (const clause of s.split(CLAUSE_END)) {
      for (const piece of sliceByWidth(clause.trim(), maxWidth)) {
        out.push({ text: piece, sentenceStart: first });
        first = false;
      }
    }
  }
  return out;
}

/**
 * 訳文を widths.length 行以内に並べる（widths[i] は i 行目に使える表示幅）。
 * 行に余裕があれば文ごとに改行し（元の行と並びが揃いやすい）、長い文は読点で区切った断片を幅いっぱいまで詰める。
 * 入りきらない分は最後の行で省略する。
 */
export function packText(text: string, widths: readonly number[]): string[] {
  const flat = text.replace(/\s*\n\s*/g, ' ').trim();
  if (flat === '' || widths.length === 0) return [];
  if (widths.length === 1) return [truncateWidth(flat, widths[0]!)];
  const lines: string[] = [];
  let current = '';
  // 区切りの基準は最も広い行に合わせる（狭い行に合わせると、広い行に収まる文まで細切れになる）
  for (const p of phrases(flat, Math.max(...widths))) {
    const canBreak = lines.length < widths.length - 1;
    if (current === '') {
      current = p.text;
    } else if (canBreak && (p.sentenceStart || displayWidth(joinLine(current, p.text)) > widths[lines.length]!)) {
      lines.push(current);
      current = p.text;
    } else {
      current = joinLine(current, p.text);
    }
  }
  lines.push(current);
  return lines.map((l, i) => truncateWidth(l, widths[i]!));
}

/**
 * 段落ごとの訳文（キャッシュにあるものだけでよい）から、表示する行を作る。
 * maxWidth はコードと訳文を合わせた1行の表示幅の目安で、各行で訳文に使える幅はコードの長さから決める。
 */
export function layoutInline(
  target: InlineTarget,
  translations: ReadonlyMap<number, string>,
  lineAt: (line: number) => string,
  maxWidth: number,
): InlineLine[] {
  const out: InlineLine[] = [];
  for (const [index, lines] of locateBlocks(target, lineAt)) {
    const text = translations.get(index);
    if (text === undefined) continue;
    const widths = lines.map((l) => Math.max(MIN_TEXT_WIDTH, maxWidth - displayWidth(lineAt(l).trimEnd()) - DECORATION_OVERHEAD));
    packText(toPlainText(text), widths).forEach((t, i) => out.push({ line: lines[i]!, text: t }));
  }
  return out;
}
