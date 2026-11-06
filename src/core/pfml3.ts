/**
 * PLaMo 3 Translate の PFML3 プロンプトを組み立てる。
 * 形式はモデルカード (pfnet/plamo-3-translate-*-GGUF) の "PFML3 Prompt Format" に従う。
 * BOS は llama.cpp が自動で付けるので含めない。
 */

const TOKEN = {
  tag: '<|plamo:tag|>',
  msg: '<|plamo:msg|>',
  key: '<|plamo:key|>',
  val: '<|plamo:val|>',
  index: '<|plamo:index|>',
  item: '<|plamo:item|>',
  bos: '<|plamo:bos|>',
} as const;

export const STOP_SEQUENCES: readonly string[] = [TOKEN.tag, TOKEN.bos];

export interface GlossaryEntry {
  source: string;
  target: string;
}

export interface TranslateRequest {
  text: string;
  /** 出力言語 (ISO 639-1 など。例: "ja", "en") */
  targetLang: string;
  /** 入力言語。省略時はモデルが判定する */
  sourceLang?: string;
  context?: string;
  glossary?: readonly GlossaryEntry[];
  /** 日本語出力のときだけ有効 */
  form?: 'plain' | 'polite';
}

/**
 * 原文に特殊トークンと同じ文字列があると、llama.cpp がそれを特殊トークンとして読み、プロンプトの構造が壊れる。
 * 語彙の特殊トークン（<|plamo:reserved:0x106|> や断片の <|plamo:begin_ / :plamo|> を含む 59 個）は
 * すべて "<|plamo:" か ":plamo|>" を含むので、この 2 つの並びだけを崩せば足りる。
 * 取り除かないのは、トークンについて書かれたコメントの訳文からその語が消えてしまうため。
 * 崩すのにゼロ幅スペースを使うのは、表示を変えず、元のソースにまず現れない並びにするため。
 * モデルはこの並びをそのまま訳文に写す（0.8B / 2B / 8B で確認）ので、cleanOutput で元に戻す。
 */
const ZWSP = '\u200B';

export function escapeSpecialTokens(s: string): string {
  return s.replaceAll('<|plamo:', `<${ZWSP}|plamo:`).replaceAll(':plamo|>', `:plamo${ZWSP}|>`);
}

export function unescapeSpecialTokens(s: string): string {
  return s.replaceAll(`<${ZWSP}|plamo:`, '<|plamo:').replaceAll(`:plamo${ZWSP}|>`, ':plamo|>');
}

export function buildPrompt(req: TranslateRequest): string {
  const clean = escapeSpecialTokens;
  let p = `${TOKEN.tag}dataset${TOKEN.msg}translation`;

  if (req.context) {
    p += `${TOKEN.tag}context${TOKEN.msg}${clean(req.context)}`;
  }
  if (req.glossary && req.glossary.length > 0) {
    p += `${TOKEN.tag}glossary`;
    for (const g of req.glossary) {
      p += `${TOKEN.index}${clean(g.source)}${TOKEN.item}${clean(g.target)}`;
    }
  }

  p += `${TOKEN.tag}input`;
  if (req.sourceLang) p += `${TOKEN.key}lang${TOKEN.val}${req.sourceLang}`;
  p += `${TOKEN.msg}${clean(req.text)}`;

  p += `${TOKEN.tag}output${TOKEN.key}lang${TOKEN.val}${req.targetLang}`;
  if (req.form && req.targetLang === 'ja') p += `${TOKEN.key}form${TOKEN.val}${req.form}`;
  p += TOKEN.msg;
  return p;
}

/** 生成結果の末尾に停止トークンが残っていれば取り除き、原文から写された特殊トークンを元の形に戻す */
export function cleanOutput(s: string): string {
  let out = s;
  for (const stop of STOP_SEQUENCES) {
    const i = out.indexOf(stop);
    if (i >= 0) out = out.slice(0, i);
  }
  return unescapeSpecialTokens(out.trim());
}
