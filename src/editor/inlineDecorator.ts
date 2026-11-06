/**
 * コメントの各行の右側に、訳文を薄い文字で表示する（行末ゴーストテキスト）。ソースは書き換えない。
 * 訳文は先読み（VisiblePrefetcher）が用意したキャッシュから取り、訳し終わった段落から順に表示する。
 */
import * as vscode from 'vscode';
import { layoutInline, type InlineLine } from '../core/inlineLayout.ts';
import { overlapsLines, type TranslationUnit } from '../core/normalize.ts';
import type { TranslationService } from '../translation/service.ts';
import type { DocumentIndex } from './documentIndex.ts';

export type InlineMode = 'off' | 'short' | 'all';

export interface InlineSettings {
  enabled: boolean;
  mode: InlineMode;
  /** コードと訳文を合わせた1行の表示幅の目安 */
  maxWidth: number;
}

const MARGIN_LINES = 20;
const SCROLL_DELAY_MS = 50;
const EDIT_DELAY_MS = 300;
const TRANSLATED_DELAY_MS = 100;

/**
 * short では、行コメント・行末コメントと、1行で書かれたコメントだけに出す。
 * JSDoc のような複数行のブロックまで出さないのは、タグや例と並んで行の右側が埋まり、コードが読みにくくなるため。
 */
export function isInlineTarget(unit: TranslationUnit, mode: InlineMode): boolean {
  if (mode === 'off' || unit.skip) return false;
  if (mode === 'all') return true;
  return unit.kind === 'line' || unit.kind === 'trailing' || unit.startLine === unit.endLine;
}

export class InlineDecorator implements vscode.Disposable {
  private readonly index: DocumentIndex;
  private readonly service: TranslationService;
  private readonly settings: () => InlineSettings;
  private readonly type: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  /** 最後に表示した内容（統合テストで確認するため） */
  private readonly shown = new Map<string, InlineLine[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private rerun = false;

  constructor(index: DocumentIndex, service: TranslationService, settings: () => InlineSettings) {
    this.index = index;
    this.service = service;
    this.settings = settings;
    this.type = vscode.window.createTextEditorDecorationType({
      after: {
        margin: '0 0 0 2ch',
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.disposables.push(
      this.type,
      vscode.window.onDidChangeTextEditorVisibleRanges(() => this.schedule(SCROLL_DELAY_MS)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule(SCROLL_DELAY_MS)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) this.schedule(EDIT_DELAY_MS);
      }),
      service.onDidTranslate(() => this.schedule(TRANSLATED_DELAY_MS)),
      service.onDidChangeState(() => this.schedule(0)),
    );
    this.schedule(0);
  }

  /** 表示中の内容（統合テスト用） */
  shownLines(uri: vscode.Uri): InlineLine[] {
    return this.shown.get(uri.toString()) ?? [];
  }

  schedule(delay: number): void {
    // 連続する更新は、最初の予定時刻にまとめる（翻訳が次々終わっても再描画しすぎない）
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, delay);
  }

  private async refresh(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      const s = this.settings();
      for (const editor of vscode.window.visibleTextEditors) {
        const doc = editor.document;
        const lines: InlineLine[] = [];
        if (s.enabled && s.mode !== 'off') {
          const units = await this.index.units(doc);
          const version = doc.version;
          for (const unit of units) {
            if (!isInlineTarget(unit, s.mode)) continue;
            const visible = editor.visibleRanges.some((r) =>
              overlapsLines(unit, r.start.line - MARGIN_LINES, r.end.line + MARGIN_LINES),
            );
            if (!visible) continue;
            const translations = this.service.peekBlocks(unit);
            if (translations.size === 0) continue;
            lines.push(...layoutInline(unit, translations, (l) => (l < doc.lineCount ? doc.lineAt(l).text : ''), s.maxWidth));
          }
          // 解析中に編集されたら、古い位置に出さない（編集後の更新で描き直す）
          if (doc.version !== version) continue;
        }
        editor.setDecorations(
          this.type,
          lines.map((l) => {
            const end = doc.lineAt(l.line).range.end;
            return { range: new vscode.Range(end, end), renderOptions: { after: { contentText: `→ ${l.text}` } } };
          }),
        );
        this.shown.set(doc.uri.toString(), lines);
      }
    } finally {
      this.running = false;
      if (this.rerun) {
        this.rerun = false;
        this.schedule(0);
      }
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}
