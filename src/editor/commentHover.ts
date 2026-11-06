/**
 * コメントの上にマウスを置いたときに訳文を出す HoverProvider。
 * キャッシュにあれば即座に返し、なければ最優先で翻訳して、終わるまでホバーを待たせる。
 * ホバーが閉じられても翻訳は止めない（結果はキャッシュに残り、次のホバーで即表示される）。
 */
import * as vscode from 'vscode';
import { containsPosition } from '../core/normalize.ts';
import { CancelledError, Priority } from '../translation/queue.ts';
import { ServerUnavailableError, type TranslationService } from '../translation/service.ts';
import type { DocumentIndex } from './documentIndex.ts';
import { escapeMarkdown, translationFooter, untilCancelled } from './hoverCommon.ts';
import { toHoverMarkdown } from './markdown.ts';

/** 接続できないときに、ホバーに出す対処のリンク */
export interface HoverAction {
  title: string;
  command: string;
  args?: unknown[];
}

export class CommentHoverProvider implements vscode.HoverProvider {
  private readonly index: DocumentIndex;
  private readonly service: TranslationService;
  private readonly isEnabled: () => boolean;
  private readonly actions: () => HoverAction[];

  constructor(index: DocumentIndex, service: TranslationService, isEnabled: () => boolean, actions: () => HoverAction[]) {
    this.index = index;
    this.service = service;
    this.isEnabled = isEnabled;
    this.actions = actions;
  }

  async provideHover(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    if (!this.isEnabled()) return undefined;
    const units = await this.index.units(doc);
    if (token.isCancellationRequested) return undefined;
    const unit = units.find((u) => !u.skip && containsPosition(u, pos.line, pos.character));
    if (!unit) return undefined;
    const range = new vscode.Range(unit.startLine, unit.startColumn, unit.endLine, unit.endColumn);

    const cached = this.service.peek(unit);
    if (cached !== undefined) return this.translationHover(cached, range);

    try {
      const text = await untilCancelled(this.service.translate(unit, Priority.Interactive).promise, token);
      return text === undefined ? undefined : this.translationHover(text, range);
    } catch (e) {
      if (e instanceof CancelledError || token.isCancellationRequested) return undefined;
      return this.errorHover(e, range);
    }
  }

  private translationHover(text: string, range: vscode.Range): vscode.Hover {
    const body = new vscode.MarkdownString(toHoverMarkdown(text));
    return new vscode.Hover([body, translationFooter(this.service)], range);
  }

  private errorHover(e: unknown, range: vscode.Range): vscode.Hover {
    const md = new vscode.MarkdownString('', true);
    const message = e instanceof Error ? e.message : String(e);
    md.appendMarkdown(`$(warning) 翻訳できませんでした: ${escapeMarkdown(message)}\n\n`);
    if (e instanceof ServerUnavailableError || e instanceof TypeError) {
      const actions = this.actions();
      md.isTrusted = { enabledCommands: actions.map((a) => a.command) };
      md.appendMarkdown(
        actions
          .map((a) => `[${escapeMarkdown(a.title)}](command:${a.command}${a.args ? `?${encodeURIComponent(JSON.stringify(a.args))}` : ''})`)
          .join(' · '),
      );
    }
    return new vscode.Hover(md, range);
  }
}
