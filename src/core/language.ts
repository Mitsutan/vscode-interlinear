/** 表示言語に追従させる出力言語。ほかの言語への訳の質はまだ確かめていないため、表示言語をそのまま使わない */
const FOLLOWED_LANGUAGES = ['ja', 'en'];

/**
 * 出力言語を設定していないときに使う出力言語を、VS Code の表示言語（vscode.env.language。例: "ja", "en", "zh-cn"）から決める。
 */
export function defaultTargetLanguage(displayLanguage: string): string {
  const base = displayLanguage.toLowerCase().split('-')[0] ?? '';
  return FOLLOWED_LANGUAGES.includes(base) ? base : 'en';
}
