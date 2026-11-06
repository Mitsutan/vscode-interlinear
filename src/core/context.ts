import path from 'node:path';
import type { Block } from './normalize.ts';

/** 翻訳サービスに渡す文章（コメント1つ、またはホバーのドキュメント1つ） */
export interface TranslatableText {
  blocks: readonly Block[];
  languageId: string;
  file: string;
  /** 関連するコード（コメントなら直後の宣言、ドキュメントならシグネチャ） */
  codeLine?: string;
  /** 何の文章か。context の書き方が変わる（省略時はコメント） */
  origin?: 'comment' | 'documentation';
}

/**
 * 翻訳時に PFML3 の context として渡す参考情報。
 * コメントの形式は、開発時の計測で多義語の誤訳（"line" → 線、"indented" → 凹む）が減ったのを確認したもの。
 * 文言を変えるとキャッシュのキーが変わる点に注意。
 */
export function buildContext(t: Pick<TranslatableText, 'languageId' | 'file' | 'codeLine' | 'origin'>): string {
  const file = path.basename(t.file);
  if (t.origin === 'documentation') {
    const parts = [`Documentation shown on hover in a ${t.languageId} source file (${file}).`];
    if (t.codeLine) parts.push(`Symbol: ${t.codeLine}`);
    return parts.join(' ');
  }
  const parts = [`Comment in a ${t.languageId} source file (${file}).`];
  if (t.codeLine) parts.push(`Related code: ${t.codeLine}`);
  return parts.join(' ');
}
