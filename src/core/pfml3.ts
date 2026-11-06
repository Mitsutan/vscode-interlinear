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

const SPECIAL_TOKEN_PATTERN = /<\|plamo:[a-z_]+\|>/g;

/** 原文に特殊トークンが含まれているとプロンプト構造が壊れるので除去する */
export function stripSpecialTokens(s: string): string {
  return s.replace(SPECIAL_TOKEN_PATTERN, '');
}

export function buildPrompt(req: TranslateRequest): string {
  const clean = stripSpecialTokens;
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

/** 生成結果の末尾に停止トークンが残っていれば取り除く */
export function cleanOutput(s: string): string {
  let out = s;
  for (const stop of STOP_SEQUENCES) {
    const i = out.indexOf(stop);
    if (i >= 0) out = out.slice(0, i);
  }
  return out.trim();
}
