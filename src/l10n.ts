/**
 * 表示言語に合わせた文言。原文は英語で、訳は l10n/bundle.l10n.<言語>.json に置く。
 * vscode に依存しない層（managed/ や translation/）は vscode.l10n を使えないので、@vscode/l10n で同じ訳を引く。
 */
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';

/** @vscode/l10n に、VS Code が表示言語に合わせて読み込んだ訳を渡す。ほかの処理より先に呼ぶ */
export function configureL10n(): void {
  if (vscode.l10n.bundle) l10n.config({ contents: vscode.l10n.bundle });
}

/** 「A、B」「A and B」のような列挙。訳のない表示言語では文言が英語になるので、列挙も英語の形にする */
export function formatList(items: readonly string[]): string {
  return new Intl.ListFormat(vscode.l10n.bundle ? vscode.env.language : 'en').format(items);
}
