/**
 * ホバーに表示される Markdown（言語サーバーが返すドキュメント）を、翻訳する文章とそのまま残す部分に分ける。
 *
 * - どの行がどのブロック（段落、見出し、引用、リスト、コード、表、HTML など）に属するかは、
 *   VS Code がホバーの表示に使うのと同じ版の marked に決めさせる。訳文のブロックの区切りを、原文の表示と揃えるため。
 *   訳文は原文の行から組み立て、訳す段落の行だけを「prefix + 訳文」の1行に置き換える。
 *   marked のトークンから Markdown を組み立て直さないのは、raw では行頭のタブが空白に、CRLF が LF に置き換わっていて、
 *   引用やリストの記号も作り直す必要があるため
 * - シグネチャ（定義）のコードブロックと区切り線は、元のホバーと重なるだけなので訳文には含めない。
 *   区切り線で区切られた各部分で、文章より前にあるコードブロックをシグネチャとみなす。
 *   多くの言語サーバーはシグネチャを先頭に置くが、clangd は区切り線の後ろの最後に置く
 * - 本文中のコード（` ``` ` で囲んだものと、gopls などが使う字下げのもの）は、訳さずに元の形のまま残す。
 *   元のホバーにもあるが、訳文だけを読んでも、前後の段落がどのコードを指しているかわかるようにするため
 * - TypeScript のタグ（`*@param* \`name\` — 説明`）は、タグ名と引数名を残して説明だけ訳す
 * - リンク先 URL はモデルに渡さず `L0` のような短い記号に置き換え、訳したあとで元に戻す。
 *   元のホバーが isTrusted（command: リンクを実行できる）でも、訳文の段落に含まれるリンクは元の文書にあったものだけになる
 * - すでに出力言語で書かれた段落や、文章がほとんどない段落は訳さない
 */
import { Lexer, type Token, type Tokens } from 'marked';
import { stripProtected } from './glossary.ts';
import { isInTargetLanguage, joinLine, reassemble, type Block } from './normalize.ts';

export interface SegmentedMarkdown {
  /** 訳文として表示するブロック（シグネチャのコードブロックと区切り線は含まない） */
  blocks: Block[];
  /** リンクの記号 L<n> に対応する元のリンク先（タイトル付きならタイトルも含む） */
  links: string[];
  /** シグネチャとみなした最初のコードブロックの1行目。context に使う */
  signature?: string;
}

/** [text](url) / ![alt](url "title") */
const LINK = /(!?\[[^\]\n]*\])\(([^()\s]+)((?:\s+"[^"\n]*")?)\)/g;
const TS_TAG = /^(\*@([\w-]+)\*(?:\s+`[^`]+`)?(?:\s+—)?\s*)(.*)$/;
const ATX_HEADING = /^#{1,6}(?:[ \t]+|$)/;
/** リンク定義（`[x]: url`）。marked と同じ規則で読み飛ばすため、marked の正規表現を使う */
const DEFINITION = Lexer.rules.block.gfm.def;

export function segmentMarkdown(markdown: string, targetLang: string): SegmentedMarkdown {
  const { blocks, signature } = splitBlocks(markdown);

  // リンク先を記号に置き換え、訳す必要のない段落を verbatim に戻す
  const links: string[] = [];
  const finalized = blocks.map((b): Block => {
    if (b.type !== 'prose') return b;
    const text = b.text.trim();
    const letters = stripProtected(text.replace(LINK, '$1')).match(/\p{L}/gu)?.length ?? 0;
    if (letters < 4 || isInTargetLanguage(stripProtected(text), targetLang)) {
      return { type: 'verbatim', text: `${b.prefix}${text}`.trimEnd() };
    }
    const protectedText = text.replace(LINK, (_m, label: string, url: string, title: string) => {
      links.push(url + title);
      return `${label}(L${links.length - 1})`;
    });
    return { type: 'prose', prefix: b.prefix, text: protectedText };
  });

  return { blocks: trimBlank(finalized), links, signature };
}

export function hasProse(seg: SegmentedMarkdown): boolean {
  return seg.blocks.some((b) => b.type === 'prose');
}

/**
 * 段落の訳文（ブロックの番号 → 訳文）を元の構造に組み戻し、ホバーに出す Markdown にする。
 * リンクを戻すのは訳文の段落だけ。そのまま残したコードにかけると、`handlers[name](event)` のような式をリンクと見なして壊すため。
 */
export function renderTranslation(seg: SegmentedMarkdown, translations: ReadonlyMap<number, string>): string {
  const restored = new Map<number, string>();
  for (const [index, text] of translations) restored.set(index, restoreLinks(text, seg.links));
  return reassemble(seg.blocks, restored);
}

/** 訳文の L<n> を元のリンク先に戻す。元の文書になかったリンク（モデルが作ったもの）は文字だけ残して外す */
export function restoreLinks(text: string, links: readonly string[]): string {
  const allowed = new Set(links);
  return text
    .replace(/\]\(L(\d+)\)/g, (m, i: string) => {
      const url = links[Number(i)];
      return url === undefined ? m : `](${url})`;
    })
    .replace(LINK, (m, label: string, url: string, title: string) => {
      if (allowed.has(url + title)) return m;
      return label.replace(/^!?\[/, '').replace(/\]$/, '');
    })
    .replace(/<([a-z][\w+.-]*:[^>\s]*)>/gi, (m, url: string) => (allowed.has(url) ? m : url))
    .trim();
}

/**
 * marked のトークンを原文の行に当てはめて、ブロックに分ける。
 * 当てはめられなかった引用やリスト項目（marked の癖が想定と違ったときなど）は、訳さずに原文のまま残す
 */
function splitBlocks(markdown: string): { blocks: Block[]; signature?: string } {
  // marked と同じく、CR だけの改行でも行を区切る
  const lines = markdown.split(/\r\n|\r|\n/);
  let signature: string | undefined;
  /** 区切り線で区切られた今の部分で、シグネチャより後ろ（本文）に入ったか */
  let inBody = false;

  const keep = (from: number, to: number): Block[] => lines.slice(from, to).map((text) => ({ type: 'verbatim', text }));

  /**
   * 段落の中身（marked が解釈した行）を原文の行と突き合わせ、prefix と、行頭と行末の空白を除いた各行を返す。
   * prefix は原文の1行目の、中身より前の部分（引用の `> `、リストの `- `、字下げなど）。
   * 原文の行が中身で終わっていなければ undefined
   */
  const match = (content: readonly string[], at: number): { prefix: string; lines: string[] } | undefined => {
    const trimmed = content.map((l) => l.trim());
    if (trimmed[0] === undefined || trimmed[0] === '') return undefined;
    if (trimmed.some((l, i) => !(lines[at + i] ?? '').trimEnd().endsWith(l))) return undefined;
    const first = lines[at]!.trimEnd();
    return { prefix: first.slice(0, first.length - trimmed[0].length), lines: trimmed };
  };

  const paragraph = (content: readonly string[], at: number): Block | undefined => {
    const m = match(content, at);
    if (m === undefined) return undefined;
    let { prefix } = m;
    let first = m.lines[0]!;
    const tag = TS_TAG.exec(first);
    if (tag) {
      // @example の後ろはコードなので、段落ごと原文のまま残す
      if (tag[2] === 'example') return undefined;
      // 説明が次の行から始まる形式（`*@param* \`x\`  ` + 改行）でも、タグと説明の間に空白を入れる
      prefix += /\s$/.test(tag[1]!) ? tag[1]! : `${tag[1]} `;
      first = tag[3]!;
    }
    return { type: 'prose', prefix, text: m.lines.slice(1).reduce((a, b) => joinLine(a, b), first) };
  };

  /**
   * 引用やリスト項目の中身（トップレベルでは文書全体）を、ブロックに分ける。
   * text は marked がその中身として解釈した文字列で、その i 行目が原文の base + i 行目にあたる。
   * トークンを原文の行に当てはめられなければ undefined
   */
  const container = (tokens: readonly Token[], text: string, base: number, count: number, top: boolean): Block[] | undefined => {
    const expanded = expandTabs(text);
    const inner = expanded.split('\n');
    const placed = place(tokens, expanded);
    if (placed === undefined || inner.length > count) return undefined;
    const starts = lineStarts(expanded);

    const out: Block[] = [];
    let next = 0;
    for (const { token, start, end } of placed) {
      const from = lineAt(starts, start);
      const to = lineAt(starts, end);
      // リンク定義など、どのトークンにも属さない行
      out.push(...keep(base + next, base + from));
      next = to;
      let last = to;
      while (last > from && inner[last - 1]!.trim() === '') last--;

      if (top && token.type === 'hr') {
        inBody = false;
        out.push(...keep(base + last, base + to));
        continue;
      }
      if (top && token.type === 'code' && (token as Tokens.Code).codeBlockStyle !== 'indented' && !inBody) {
        signature ??= (token as Tokens.Code).text
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l !== '')
          ?.slice(0, 200);
        out.push(...keep(base + last, base + to));
        continue;
      }
      if (top && token.type !== 'space') inBody = true;

      const blocks = convert(token, start, from, last, to);
      out.push(...(blocks ?? keep(base + from, base + to)));
    }
    out.push(...keep(base + next, base + count));
    return out;

    /** トークンをブロックにする。原文のまま残すなら undefined */
    function convert(token: Token, start: number, from: number, last: number, to: number): Block[] | undefined {
      switch (token.type) {
        case 'paragraph':
        case 'text': {
          const block = paragraph(inner.slice(from, last), base + from);
          return block && [block, ...keep(base + last, base + to)];
        }
        case 'heading': {
          const marker = ATX_HEADING.exec(inner[from]!.trim());
          if (marker) {
            const m = match(inner.slice(from, from + 1), base + from);
            if (m === undefined) return undefined;
            const block: Block = { type: 'prose', prefix: m.prefix + marker[0], text: (token as Tokens.Heading).text };
            return [block, ...keep(base + from + 1, base + to)];
          }
          // setext の見出しは、文の行だけを訳し、下線の行は残す
          const block = paragraph(inner.slice(from, last - 1), base + from);
          return block && [block, ...keep(base + last - 1, base + to)];
        }
        case 'blockquote': {
          const quote = token as Tokens.Blockquote;
          return container(quote.tokens, quote.text, base + from, to - from, false);
        }
        case 'list': {
          const list = token as Tokens.List;
          // 項目の raw をつないだものが、リストの raw の先頭にあたる（リストの raw の末尾には、次の行との間の改行が付くことがある）
          const items = list.items.map((item) => item.raw).join('');
          if (!list.raw.startsWith(items) || list.raw.slice(items.length).trim() !== '') return undefined;
          const blocks: Block[] = [];
          let itemStart = start;
          let covered = from;
          for (const item of list.items) {
            const f = lineAt(starts, itemStart);
            const t = lineAt(starts, itemStart + item.raw.length);
            blocks.push(...keep(base + covered, base + f));
            blocks.push(...(container(item.tokens, item.text, base + f, t - f, false) ?? keep(base + f, base + t)));
            itemStart += item.raw.length;
            covered = t;
          }
          return [...blocks, ...keep(base + covered, base + to)];
        }
        default:
          // 本文中のコード、表、HTML など
          return undefined;
      }
    }
  };

  const blocks = container(Lexer.lex(markdown), markdown.replace(/\r\n|\r/g, '\n'), 0, lines.length, true);
  return { blocks: blocks ?? keep(0, lines.length), signature };
}

/**
 * 各トークンが text の何文字目から何文字目にあたるかを、raw の長さを足して求める。
 * marked はトップレベルのリンク定義をトークンに含めないので、合わないところはリンク定義として読み飛ばす。
 * それでも合わなければ undefined
 */
function place(tokens: readonly Token[], text: string): Array<{ token: Token; start: number; end: number }> | undefined {
  const placed: Array<{ token: Token; start: number; end: number }> = [];
  let at = 0;
  const skipDefinitions = (done: () => boolean): boolean => {
    while (!done()) {
      const def = DEFINITION.exec(text.slice(at));
      if (def === null) return false;
      at += def[0].length;
    }
    return true;
  };
  for (const token of tokens) {
    const raw = rawOf(token);
    if (!skipDefinitions(() => text.startsWith(raw, at))) return undefined;
    placed.push({ token, start: at, end: at + raw.length });
    at += raw.length;
  }
  if (!skipDefinitions(() => text.slice(at).trim() === '')) return undefined;
  return placed;
}

/**
 * marked 14.0.0 は、リスト項目の中で文章の行（text トークン）をつなぐとき、前の raw の末尾の改行にさらに改行を足す
 * （"a\n" + "\n" + "b"）。文章の行の間に空行は入らないので、続く改行を1つに戻す
 */
function rawOf(token: Token): string {
  return token.type === 'text' ? token.raw.replace(/\n\n/g, '\n') : token.raw;
}

/** marked が解釈する前に行うのと同じ置き換え（行頭のタブを 4 つの空白にする） */
function expandTabs(text: string): string {
  return text.replace(/^( *)(\t+)/gm, (_m, spaces: string, tabs: string) => spaces + '    '.repeat(tabs.length));
}

/** 各行の始まりの位置 */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** offset 以降で始まる最初の行の番号。トークンは、始まりの位置がトークンの範囲にある行を持つ */
function lineAt(starts: readonly number[], offset: number): number {
  let n = 0;
  while (n < starts.length && starts[n]! < offset) n++;
  return n;
}

/**
 * 前後の空行を取り除く。
 * 間に続く空行を1つに詰めないのは、コードブロックの中の空行を変えないため（それ以外では Markdown の表示は変わらない）
 */
function trimBlank(blocks: Block[]): Block[] {
  let s = 0;
  let e = blocks.length;
  const blank = (b: Block | undefined) => b?.type === 'verbatim' && b.text.trim() === '';
  while (s < e && blank(blocks[s])) s++;
  while (e > s && blank(blocks[e - 1])) e--;
  return blocks.slice(s, e);
}
