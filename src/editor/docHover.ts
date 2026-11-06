/**
 * 言語サーバーなどがホバーで出すドキュメントを翻訳して、同じホバーに「翻訳」として追加する。
 *
 * 他のプロバイダのホバーは書き換えられないので、自分の HoverProvider から vscode.executeHoverProvider を呼んで
 * 内容を取り出す。このコマンドは自分自身も呼び出すので、同じ位置の呼び出しには何も返さない（再入ガード）。
 * 翻訳には時間がかかることがあるが、VS Code は先に揃った他のプロバイダの結果を表示し、
 * こちらの結果は届いた時点で追加する（待っている間は「Loading...」）。
 */
import * as vscode from 'vscode';
import type { TranslatableText } from '../core/context.ts';
import { CommentExtractor } from '../core/extract.ts';
import { hasProse, restoreLinks, segmentMarkdown, type SegmentedMarkdown } from '../core/markdownBlocks.ts';
import { containsPosition } from '../core/normalize.ts';
import { Priority, type TaskHandle } from '../translation/queue.ts';
import type { TranslationService } from '../translation/service.ts';
import type { DocumentIndex } from './documentIndex.ts';
import { translationFooter, untilCancelled } from './hoverCommon.ts';

interface SourceMarkdown {
  value: string;
  isTrusted?: vscode.MarkdownString['isTrusted'];
  supportHtml?: boolean;
  supportThemeIcons?: boolean;
  baseUri?: vscode.Uri;
}

interface Item {
  source: SourceMarkdown;
  segmented: SegmentedMarkdown;
  text: TranslatableText;
}

export class DocHoverProvider implements vscode.HoverProvider {
  private readonly index: DocumentIndex;
  private readonly service: TranslationService;
  private readonly isEnabled: () => boolean;
  /** executeHoverProvider で自分自身が呼ばれたことを見分けるための、処理中の位置 */
  private readonly inFlight = new Set<string>();

  constructor(index: DocumentIndex, service: TranslationService, isEnabled: () => boolean) {
    this.index = index;
    this.service = service;
    this.isEnabled = isEnabled;
  }

  async provideHover(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    if (!this.isEnabled() || !CommentExtractor.supports(doc.languageId)) return undefined;
    const key = `${doc.uri.toString()}\u0000${doc.version}\u0000${pos.line}:${pos.character}`;
    if (this.inFlight.has(key)) return undefined;

    // コメントの中は、コメントの翻訳（CommentHoverProvider）に任せる
    const units = await this.index.units(doc);
    if (units.some((u) => containsPosition(u, pos.line, pos.character))) return undefined;
    if (token.isCancellationRequested) return undefined;

    let hovers: vscode.Hover[];
    this.inFlight.add(key);
    try {
      hovers = (await vscode.commands.executeCommand<vscode.Hover[] | undefined>('vscode.executeHoverProvider', doc.uri, pos)) ?? [];
    } finally {
      this.inFlight.delete(key);
    }
    if (token.isCancellationRequested) return undefined;

    const targetLang = this.service.currentSettings.targetLang;
    const sources = hovers
      .flatMap((h) => h.contents)
      .map(toSource)
      .map((source) => ({ source, segmented: segmentMarkdown(source.value, targetLang) }));
    // TypeScript などはシグネチャ（コードブロック）と説明文を別の部品で返すので、ホバー全体で最初のものを使う
    const signature = sources.find((s) => s.segmented.signature !== undefined)?.segmented.signature;
    const items: Item[] = sources
      .filter(({ segmented }) => hasProse(segmented))
      .map(({ source, segmented }) => ({
        source,
        segmented,
        text: {
          blocks: segmented.blocks,
          languageId: doc.languageId,
          file: doc.fileName,
          codeLine: segmented.signature ?? signature,
          origin: 'documentation',
        },
      }));
    if (items.length === 0) return undefined;
    const range = hovers.find((h) => h.range)?.range;

    const cached = items.map((i) => this.service.peek(i.text));
    if (cached.every((c) => c !== undefined)) return this.render(items, cached as string[], range);

    const handles: Array<TaskHandle<string> | undefined> = items.map((item, i) =>
      cached[i] === undefined ? this.service.translate(item.text, Priority.Interactive) : undefined,
    );
    try {
      const results = await untilCancelled(
        Promise.all(handles.map((h, i) => (h ? h.promise : Promise.resolve(cached[i]!)))),
        token,
      );
      if (results === undefined) {
        // 記号へのホバーは偶発的なことが多いので、閉じられたら待機中の翻訳は取り消す（実行中のものは結果をキャッシュに残す）
        for (const h of handles) h?.cancel();
        return undefined;
      }
      return this.render(items, results, range);
    } catch {
      // 接続できないときなどは何も出さない（記号にホバーするたびにエラーを出さないため。状態はステータスバーに出る）
      for (const h of handles) h?.cancel();
      return undefined;
    }
  }

  private render(items: readonly Item[], texts: readonly string[], range: vscode.Range | undefined): vscode.Hover | undefined {
    const contents: vscode.MarkdownString[] = [];
    items.forEach((item, i) => {
      const body = restoreLinks(texts[i] ?? '', item.segmented.links);
      if (body === '') return;
      const md = new vscode.MarkdownString(body);
      // 元のホバーと同じ扱いにする（command: リンクなど）。訳文のリンクは restoreLinks で元にあったものだけになっている
      md.isTrusted = item.source.isTrusted;
      md.supportHtml = item.source.supportHtml ?? false;
      md.supportThemeIcons = item.source.supportThemeIcons ?? false;
      md.baseUri = item.source.baseUri;
      contents.push(md);
    });
    if (contents.length === 0) return undefined;
    contents.push(translationFooter(this.service));
    return new vscode.Hover(contents, range);
  }
}

function toSource(c: vscode.MarkdownString | vscode.MarkedString): SourceMarkdown {
  if (typeof c === 'string') return { value: c };
  if (c instanceof vscode.MarkdownString) return c;
  if ('language' in c) return { value: `\`\`\`${c.language}\n${c.value}\n\`\`\`` };
  return { value: (c as { value: string }).value };
}
