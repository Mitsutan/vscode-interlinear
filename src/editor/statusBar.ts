/**
 * ステータスバーの表示。対応言語のエディタがアクティブなときだけ出す。
 *   $(globe) ja          待機中（接続 OK）
 *   $(sync~spin) 翻訳中 3  翻訳リクエストが残っている
 *   $(warning) 翻訳       サーバーに接続できない
 *   $(circle-slash) 翻訳  無効
 *   $(cloud-download) 翻訳: セットアップ  自動管理モードで、モデルがまだない（クリックでセットアップ）
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
      this.item.text = '$(cloud-download) 翻訳: セットアップ';
      this.item.tooltip = '翻訳モデルをダウンロードして、コメントの翻訳を使えるようにします（クリック）';
      this.item.command = 'interlinear.setup';
    } else if (!c.enabled) {
      this.item.text = '$(circle-slash) 翻訳';
      this.item.tooltip = 'コメントの翻訳は無効です（クリックでメニュー）';
    } else if (state.status === 'down') {
      this.item.text = '$(warning) 翻訳';
      this.item.tooltip = `${state.message}\nクリックでメニュー`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (pending > 0) {
      this.item.text = `$(sync~spin) 翻訳中 ${pending}`;
      this.item.tooltip = this.details(c);
    } else {
      this.item.text = `$(globe) ${c.targetLang}`;
      this.item.tooltip = this.details(c);
    }
    this.item.show();
  }

  private details(c: ExtensionConfig): string {
    const state = this.service.serverState;
    const model = state.status === 'ok' ? state.model : '確認中…';
    return [
      `出力言語: ${c.targetLang}`,
      `モデル: ${model}`,
      `サーバー: ${serverLabel(c)}`,
      `キャッシュ: ${this.service.cache.size} 件`,
      'クリックでメニュー',
    ].join('\n');
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
