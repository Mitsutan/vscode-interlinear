/**
 * ホバーに表示される Markdown（言語サーバーが返すドキュメント）を、翻訳する文章とそのまま残す部分に分ける。
 *
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
const HEADING = /^(#{1,6}\s+)(.*)$/;
const QUOTE = /^(>\s?)(.*)$/;
const LIST_ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/;
const RULE = /^([-*_])(\s*\1){2,}$/;

export function segmentMarkdown(markdown: string, targetLang: string): SegmentedMarkdown {
  const blocks: Block[] = [];
  let open: Extract<Block, { type: 'prose' }> | undefined;
  let fence: { marker: string; keep: boolean } | undefined;
  let signature: string | undefined;
  /** 区切り線で区切られた今の部分で、シグネチャより後ろ（本文）に入ったか */
  let inBody = false;
  let inExample = false;
  /** 開いているリスト項目の本文が始まる桁 */
  let listColumn: number | undefined;

  const verbatim = (text: string) => {
    open = undefined;
    blocks.push({ type: 'verbatim', text });
  };
  const prose = (prefix: string, text: string) => {
    open = { type: 'prose', prefix, text };
    blocks.push(open);
  };

  for (const line of markdown.split(/\r?\n/)) {
    const t = line.trim();

    // シグネチャのコードブロックは表示しない。最初のものの1行目をシグネチャとして覚える
    if (fence !== undefined) {
      const closing = t.startsWith(fence.marker);
      if (fence.keep) verbatim(line);
      else if (!closing && signature === undefined && t !== '') signature = t.slice(0, 200);
      if (closing) fence = undefined;
      open = undefined;
      continue;
    }

    if (t === '') {
      inExample = false;
      verbatim('');
      continue;
    }

    const leading = /^[ \t]*/.exec(line)![0];
    const indent = columns(leading);
    // 段落の途中の行は字下げに関係なく段落の続きなので、リストが終わるのは段落の外で浅い行が来たときだけ
    if (open === undefined && listColumn !== undefined && indent < listColumn) listColumn = undefined;
    // 字下げによるコードブロック（CommonMark と同じく、段落の途中では始まらない）。
    // リストの中では、項目の本文より浅い字下げは項目の続きの段落になる
    if (open === undefined && indent >= (listColumn ?? 0) + 4) {
      inBody = true;
      verbatim(line);
      continue;
    }

    const fenceStart = /^(`{3,}|~{3,})/.exec(t);
    if (fenceStart) {
      fence = { marker: fenceStart[1]!, keep: inBody };
      if (fence.keep) verbatim(line);
      else open = undefined;
      continue;
    }
    if (RULE.test(t)) {
      inBody = false;
      open = undefined;
      continue;
    }
    inBody = true;

    // 表と、HTML だけの行はそのまま
    if (/^\|.*\|$/.test(t) || /^<[^>]+>$/.test(t)) {
      verbatim(line);
      continue;
    }
    if (inExample) {
      verbatim(line);
      continue;
    }

    const tag = TS_TAG.exec(t);
    if (tag) {
      if (tag[2] === 'example') {
        verbatim(line);
        inExample = true;
        continue;
      }
      // 説明が次の行から始まる形式（`*@param* \`x\`  ` + 改行）でも、タグと説明の間に空白を入れる
      const prefix = /\s$/.test(tag[1]!) ? tag[1]! : `${tag[1]} `;
      prose(prefix, tag[3]!);
      continue;
    }
    const heading = HEADING.exec(t);
    if (heading) {
      prose(heading[1]!, heading[2]!);
      open = undefined; // 見出しは1行で終わる
      continue;
    }
    const quote = QUOTE.exec(t);
    if (quote) {
      if (open?.prefix.startsWith('>')) open.text = joinLine(open.text, quote[2]!);
      else prose(quote[1]!, quote[2]!);
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      listColumn = columns(item[1]!);
      prose(item[1]!, item[2]!);
      continue;
    }
    if (open) {
      open.text = joinLine(open.text, t);
      continue;
    }
    // 字下げを残すのは、リスト項目の続きの段落を、訳文でもリストの中に置くため
    prose(leading, t);
  }

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

/** 文字列が占める桁数。タブは次の 4 の倍数の桁まで進める（CommonMark と同じ数え方） */
function columns(s: string): number {
  let n = 0;
  for (const c of s) n = c === '\t' ? n + 4 - (n % 4) : n + 1;
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
