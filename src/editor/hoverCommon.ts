/** コメントのホバーとドキュメントのホバーで共通の処理 */
import * as vscode from 'vscode';
import type { TranslationService } from '../translation/service.ts';

/** 行の途中に埋め込む文字列で、書式として解釈される記号だけをエスケープする */
export function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_[\]<>|]/g, '\\$&');
}

/** 訳文の下に出す「ローカル翻訳 · モデル名」 */
export function translationFooter(service: TranslationService): vscode.MarkdownString {
  const state = service.serverState;
  return new vscode.MarkdownString(
    `$(globe) ${vscode.l10n.t('Local translation')}${state.status === 'ok' ? ` · ${escapeMarkdown(state.model)}` : ''}`,
    true,
  );
}

/** ホバーが閉じられたら undefined で返す（元の処理は止めない） */
export function untilCancelled<T>(promise: Promise<T>, token: vscode.CancellationToken): Promise<T | undefined> {
  if (token.isCancellationRequested) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    const sub = token.onCancellationRequested(() => {
      sub.dispose();
      resolve(undefined);
    });
    promise.then(
      (v) => {
        sub.dispose();
        resolve(v);
      },
      (e: unknown) => {
        sub.dispose();
        reject(e);
      },
    );
  });
}
