/**
 * ステータスバーの表示。対応言語のエディタがアクティブなときだけ出す。
 *   $(globe) ja                       待機中（接続 OK）
 *   $(sync~spin) Translating 3        翻訳リクエストが残っている
 *   $(warning) Translation            サーバーに接続できない
 *   $(circle-slash) Translation       無効
 *   $(cloud-download) Translation: Set Up  自動管理モードで、モデルがまだない（クリックでセットアップ）
 */
import * as vscode from 'vscode';
import { serverLabel, type ExtensionConfig } from '../config.ts';
import { CommentExtractor } from '../core/extract.ts';
import type { TranslationService } from '../translation/service.ts';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly service: TranslationService;
  private readonly config: () => ExtensionConfig;
  private readonly needsSetup: () => boolean;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(service: TranslationService, config: () => ExtensionConfig, needsSetup: () => boolean) {
    this.service = service;
    this.config = config;
    this.needsSetup = needsSetup;
    this.item = vscode.window.createStatusBarItem('interlinear.status', vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Interlinear';
    this.item.command = 'interlinear.showMenu';
    this.disposables.push(
      this.item,
      service.onDidChangeState(() => this.update()),
      service.queue.onDidChange(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
    );
    this.update();
  }

  update(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !CommentExtractor.supports(editor.document.languageId)) {
      this.item.hide();
      return;
    }
    const c = this.config();
    const state = this.service.serverState;
    const pending = this.service.queue.pending;
    this.item.backgroundColor = undefined;
    this.item.command = 'interlinear.showMenu';

    if (c.enabled && this.needsSetup()) {
      this.item.text = `$(cloud-download) ${vscode.l10n.t('Translation: Set Up')}`;
      this.item.tooltip = vscode.l10n.t('Download the translation model to start translating comments (click)');
      this.item.command = 'interlinear.setup';
    } else if (!c.enabled) {
      this.item.text = `$(circle-slash) ${vscode.l10n.t('Translation')}`;
      this.item.tooltip = vscode.l10n.t('Comment translation is disabled (click for menu)');
    } else if (state.status === 'down') {
      this.item.text = `$(warning) ${vscode.l10n.t('Translation')}`;
      this.item.tooltip = `${state.message}\n${vscode.l10n.t('Click for menu')}`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (pending > 0) {
      this.item.text = `$(sync~spin) ${vscode.l10n.t('Translating {0}', pending)}`;
      this.item.tooltip = this.details(c);
    } else {
      this.item.text = `$(globe) ${c.targetLang}`;
      this.item.tooltip = this.details(c);
    }
    this.item.show();
  }

  private details(c: ExtensionConfig): string {
    const state = this.service.serverState;
    const model = state.status === 'ok' ? state.model : vscode.l10n.t('Checking…');
    return [
      vscode.l10n.t('Output language: {0}', c.targetLang),
      vscode.l10n.t('Model: {0}', model),
      vscode.l10n.t('Server: {0}', serverLabel(c)),
      vscode.l10n.t('Cache: {0} entries', this.service.cache.size),
      vscode.l10n.t('Click for menu'),
    ].join('\n');
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
