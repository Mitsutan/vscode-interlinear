/**
 * 画面に表示されているコメントを先に翻訳しておく。
 * スクロールや編集のたびに「いま見えている範囲（前後に余白を足す）」を計算し直し、
 * 見えなくなったコメントの待機中リクエストは取り消す（実行中のものは最後まで走り、結果はキャッシュに残る）。
 */
import * as vscode from 'vscode';
import { overlapsLines, type TranslationUnit } from '../core/normalize.ts';
import { Priority, type TaskHandle } from '../translation/queue.ts';
import type { TranslationService } from '../translation/service.ts';
import type { DocumentIndex } from './documentIndex.ts';

/** 見えている範囲の前後に足す行数 */
const MARGIN_LINES = 20;
const SCROLL_DELAY_MS = 300;
const EDIT_DELAY_MS = 1000;

export class VisiblePrefetcher implements vscode.Disposable {
  private readonly index: DocumentIndex;
  private readonly service: TranslationService;
  private readonly isEnabled: () => boolean;
  private readonly handles = new Map<string, TaskHandle<string>>();
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private rerun = false;

  constructor(index: DocumentIndex, service: TranslationService, isEnabled: () => boolean) {
    this.index = index;
    this.service = service;
    this.isEnabled = isEnabled;
    this.disposables.push(
      vscode.window.onDidChangeTextEditorVisibleRanges(() => this.schedule()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) this.schedule(EDIT_DELAY_MS);
      }),
    );
    this.schedule();
  }

  schedule(delay = SCROLL_DELAY_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, delay);
  }

  /** 進行中の先読みをすべて取り消す（設定変更時など） */
  cancelAll(): void {
    for (const h of this.handles.values()) h.cancel();
    this.handles.clear();
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      if (!this.isEnabled()) {
        this.cancelAll();
        return;
      }
      const wanted = new Map<string, TranslationUnit>();
      for (const editor of vscode.window.visibleTextEditors) {
        const doc = editor.document;
        const units = await this.index.units(doc);
        for (const range of editor.visibleRanges) {
          const from = range.start.line - MARGIN_LINES;
          const to = range.end.line + MARGIN_LINES;
          for (const u of units) {
            if (!u.skip && overlapsLines(u, from, to)) wanted.set(`${doc.uri}\u0000${u.startLine}\u0000${u.body}`, u);
          }
        }
      }

      for (const [key, handle] of this.handles) {
        if (!wanted.has(key)) {
          handle.cancel();
          this.handles.delete(key);
        }
      }
      for (const [key, unit] of wanted) {
        if (this.handles.has(key) || this.service.peek(unit) !== undefined) continue;
        const handle = this.service.translate(unit, Priority.Visible);
        this.handles.set(key, handle);
        handle.promise
          .catch(() => {
            // 失敗（接続できない・取り消し）は次のスクロールで再試行する
          })
          .finally(() => {
            if (this.handles.get(key) === handle) this.handles.delete(key);
          });
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
    this.cancelAll();
    for (const d of this.disposables) d.dispose();
  }
}
