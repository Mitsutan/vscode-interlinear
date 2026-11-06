/**
 * 訳文をホバーの Markdown として表示するための整形（vscode に依存しない純粋関数）。
 *
 * コメントは Markdown とは限らないので、誤解釈されやすい部分だけを調整する:
 * - 行頭の `>` `#`（Python の doctest `>>>` が引用に、`#` が見出しになる）をエスケープ
 * - 行頭のスペースを NBSP に置き換え、4つ以上のインデントがコードブロックにならないようにする
 * - 改行をそのまま改行として表示する（Markdown では段落内の改行が無視されるため）
 * コードフェンスの中は手を付けない。
 */
export function toHoverMarkdown(text: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (fence) {
      out.push(line);
      if (t.startsWith(fence)) fence = undefined;
      continue;
    }
    const fenceStart = /^(`{3,}|~{3,})/.exec(t);
    if (fenceStart) {
      fence = fenceStart[1];
      out.push(line.trimStart());
      continue;
    }
    if (t === '') {
      out.push('');
      continue;
    }
    const indent = /^\s*/.exec(line)![0];
    const body = line.slice(indent.length).replace(/^([>#])/, '\\$1');
    out.push(`${' '.repeat(indent.length)}${body}  `);
  }
  return out.join('\n');
}
