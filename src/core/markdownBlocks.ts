/**
 * ホバーに表示される Markdown（言語サーバーが返すドキュメント）を、翻訳する文章とそのまま残す部分に分ける。
 *
 * - コードブロック（シグネチャや @example）と区切り線は、元のホバーに表示されているので訳文には含めない
 * - TypeScript のタグ（`*@param* \`name\` — 説明`）は、タグ名と引数名を残して説明だけ訳す
 * - リンク先 URL はモデルに渡さず `L0` のような短い記号に置き換え、訳したあとで元に戻す。
 *   元のホバーが isTrusted（command: リンクを実行できる）でも、訳文に含まれるリンクは元の文書にあったものだけになる
 * - すでに出力言語で書かれた段落や、文章がほとんどない段落は訳さない
 */
import { stripProtected } from './glossary.ts';
import { isInTargetLanguage, joinLine, type Block } from './normalize.ts';

export interface SegmentedMarkdown {
  /** 訳文として表示するブロック（コードブロックと区切り線は含まない） */
  blocks: Block[];
  /** リンクの記号 L<n> に対応する元のリンク先（タイトル付きならタイトルも含む） */
  links: string[];
  /** 最初のコードブロックの1行目。シンボルのシグネチャとして context に使う */
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
  let fence: string | undefined;
  let signature: string | undefined;
  let inExample = false;

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

    // コードブロックは表示しない（元のホバーにある）。最初のものの1行目をシグネチャとして覚える
    if (fence !== undefined) {
      if (t.startsWith(fence)) {
        fence = undefined;
      } else if (signature === undefined && t !== '') {
        signature = t.slice(0, 200);
      }
      open = undefined;
      continue;
    }
    const fenceStart = /^(`{3,}|~{3,})/.exec(t);
    if (fenceStart) {
      fence = fenceStart[1]!;
      open = undefined;
      continue;
    }

    if (t === '') {
      inExample = false;
      verbatim('');
      continue;
    }
    if (RULE.test(t)) {
      open = undefined;
      continue;
    }
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
      prose(item[1]!, item[2]!);
      continue;
    }
    if (open) {
      open.text = joinLine(open.text, t);
      continue;
    }
    prose('', t);
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
 * 訳文の L<n> を元のリンク先に戻す。元の文書になかったリンク（モデルが作ったもの）は文字だけ残して外す。
 * 空行が3つ以上続く部分も詰める。
 */
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
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function trimBlank(blocks: Block[]): Block[] {
  let s = 0;
  let e = blocks.length;
  const blank = (b: Block | undefined) => b?.type === 'verbatim' && b.text.trim() === '';
  while (s < e && blank(blocks[s])) s++;
  while (e > s && blank(blocks[e - 1])) e--;
  // 連続する空行は1つにする
  return blocks.slice(s, e).filter((b, i, arr) => !(blank(b) && blank(arr[i - 1])));
}
