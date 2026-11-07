import * as vscode from 'vscode';
import {
  SECTION,
  affectsTranslation,
  backendKey,
  readConfig,
  serverLabel,
  toTranslatorSettings,
  type ExtensionConfig,
} from './config.ts';
import { CommentExtractor, SUPPORTED_LANGUAGE_IDS } from './core/extract.ts';
import { CommentHoverProvider, type HoverAction } from './editor/commentHover.ts';
import { DocHoverProvider } from './editor/docHover.ts';
import { DocumentIndex } from './editor/documentIndex.ts';
import { InlineDecorator, type InlineMode } from './editor/inlineDecorator.ts';
import { VisiblePrefetcher } from './editor/prefetch.ts';
import { ServerController } from './editor/server.ts';
import { StatusBar } from './editor/statusBar.ts';
import { configureL10n, formatList } from './l10n.ts';
import { MODELS } from './managed/manifest.ts';
import { TranslationCache } from './translation/cache.ts';
import { TaskQueue } from './translation/queue.ts';
import { TranslationService } from './translation/service.ts';

const CACHE_MAX_ENTRIES = 20_000;

/** 統合テストから内部状態を確認するための公開 API */
export interface ExtensionApi {
  readonly service: TranslationService;
  readonly index: DocumentIndex;
  readonly server: ServerController;
  /** コメントの右側に表示中の訳文 */
  inlineLines(uri: vscode.Uri): ReadonlyArray<{ line: number; text: string }>;
}

let onDeactivate: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  configureL10n();
  let config: ExtensionConfig = readConfig();

  const server = new ServerController(context);
  const extractor = new CommentExtractor(vscode.Uri.joinPath(context.extensionUri, 'dist', 'wasm').fsPath);
  const index = new DocumentIndex(extractor, () => config.targetLang);
  const cache = new TranslationCache({
    maxEntries: CACHE_MAX_ENTRIES,
    file: vscode.Uri.joinPath(context.globalStorageUri, 'translations-v1.json').fsPath,
  });
  void cache.load();
  const queue = new TaskQueue(config.maxConcurrentRequests);
  const service = new TranslationService(server.createBackend(config), toTranslatorSettings(config), cache, queue);
  onDeactivate = async () => {
    await cache.flush();
    await server.dispose();
  };

  const errorActions = (): HoverAction[] =>
    config.serverMode === 'managed'
      ? [
          ...(server.needsSetup ? [{ title: vscode.l10n.t('Set Up'), command: 'interlinear.setup' }] : []),
          { title: vscode.l10n.t('Restart Server'), command: 'interlinear.restartServer' },
          { title: vscode.l10n.t('Show Log'), command: 'interlinear.showServerLog' },
        ]
      : [
          { title: vscode.l10n.t('Check Connection Again'), command: 'interlinear.checkServer' },
          { title: vscode.l10n.t('Endpoint Settings'), command: 'workbench.action.openSettings', args: [`${SECTION}.endpoint`] },
        ];
  const hover = new CommentHoverProvider(index, service, () => config.enabled, errorActions);
  const docHover = new DocHoverProvider(index, service, () => config.enabled && config.translateDocumentation);
  // 行末に訳文を出すには翻訳が要るので、先読みが無効でも行末表示が有効なら画面内を訳す
  const prefetcher = new VisiblePrefetcher(
    index,
    service,
    () => config.enabled && (config.prefetch || config.inlineTranslation !== 'off'),
  );
  const inline = new InlineDecorator(index, service, () => ({
    enabled: config.enabled,
    mode: config.inlineTranslation,
    maxWidth: config.inlineMaxWidth,
  }));
  const status = new StatusBar(service, () => config, () => server.needsSetup);

  /** サーバーの作り方が変わったとき（セットアップ完了・モード切り替え・モデル変更）に作り直す */
  const rebuildBackend = () => {
    prefetcher.cancelAll();
    service.reconfigure(server.createBackend(config), toTranslatorSettings(config));
  };
  const applyConfig = async () => {
    const next = readConfig();
    const prev = config;
    config = next;
    if (backendKey(prev) !== backendKey(next)) {
      rebuildBackend();
    } else if (affectsTranslation(prev, next)) {
      prefetcher.cancelAll();
      // サーバーはそのままで、訳し方（出力言語・用語集など）だけを変える。自動管理のサーバーを起動し直さないため
      service.updateSettings(toTranslatorSettings(next));
    }
    if (prev.targetLang !== next.targetLang) index.clear();
    queue.setConcurrency(next.maxConcurrentRequests);
    if (!next.enabled || (!next.prefetch && next.inlineTranslation === 'off')) prefetcher.cancelAll();
    await server.refreshSetupState(next);
    prefetcher.schedule();
    inline.schedule(0);
    status.update();
  };
  void (async () => {
    await server.refreshSetupState(config);
    if (!server.needsSetup) await service.checkServer();
    await server.promptIfNeeded(config);
  })();

  context.subscriptions.push(
    index,
    prefetcher,
    inline,
    status,
    vscode.languages.registerHoverProvider(
      SUPPORTED_LANGUAGE_IDS.map((language) => ({ language })),
      hover,
    ),
    // 言語を指定したセレクタにしないのは、TypeScript などと同じ一致度になり、後から登録したこちらが先に並ぶため。
    // そうなると訳文が元のドキュメントの上に後から差し込まれ、読んでいる原文が下にずれる。
    // ワイルドカードは一致度が低いので後ろ（下）に並ぶ。対象言語は DocHoverProvider の中で絞る。
    vscode.languages.registerHoverProvider({ language: '*' }, docHover),
    // サーバーが復旧したら先読みを再開する
    service.onDidChangeState(() => prefetcher.schedule()),
    server.onDidChange(() => status.update()),
    // ワークスペースが信頼されると、ワークスペースの設定（接続先など）が有効になる
    vscode.workspace.onDidGrantWorkspaceTrust(() => applyConfig()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) void applyConfig();
    }),
    vscode.commands.registerCommand('interlinear.setup', async () => {
      if (await server.runSetup(config)) {
        // 設定（モデル・モード）が変わらなかったときも、新しく入れたファイルで作り直す
        config = readConfig();
        await server.refreshSetupState(config);
        rebuildBackend();
        status.update();
      }
    }),
    vscode.commands.registerCommand('interlinear.restartServer', async () => {
      await server.restart();
      const state = await service.checkServer();
      if (state.status === 'down') void vscode.window.showWarningMessage(state.message);
    }),
    vscode.commands.registerCommand('interlinear.showServerLog', () => server.output.show()),
    vscode.commands.registerCommand('interlinear.removeModels', async () => {
      const removed = await server.removeModels(config);
      if (removed.length === 0) return;
      await server.refreshSetupState(config);
      if (removed.includes(config.model)) rebuildBackend();
      status.update();
      void vscode.window.showInformationMessage(vscode.l10n.t('Removed {0}', formatList(removed.map((size) => MODELS[size].label))));
    }),
    vscode.commands.registerCommand('interlinear.toggle', async () => {
      await vscode.workspace.getConfiguration(SECTION).update('enabled', !config.enabled, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        config.enabled ? vscode.l10n.t('Comment translation enabled') : vscode.l10n.t('Comment translation disabled'),
      );
    }),
    vscode.commands.registerCommand('interlinear.toggleInline', async () => {
      // オフから戻すときは、直前に使っていた範囲（short / all）に戻す
      const current = config.inlineTranslation;
      const next: InlineMode = current === 'off' ? context.globalState.get<InlineMode>('lastInlineMode', 'short') : 'off';
      if (current !== 'off') await context.globalState.update('lastInlineMode', current);
      await vscode.workspace.getConfiguration(SECTION).update('inlineTranslation', next, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('interlinear.checkServer', async () => {
      const state = await service.checkServer();
      if (state.status === 'ok') {
        void vscode.window.showInformationMessage(vscode.l10n.t('Connected to the translation server: {0} ({1})', state.model, serverLabel(config)));
        return;
      }
      const message = state.status === 'down' ? state.message : vscode.l10n.t('Could not determine the translation server status');
      const setup = vscode.l10n.t('Set Up');
      const showLog = vscode.l10n.t('Show Log');
      const openSettings = vscode.l10n.t('Open Settings');
      const action = config.serverMode === 'managed' ? (server.needsSetup ? setup : showLog) : openSettings;
      const picked = await vscode.window.showWarningMessage(message, action);
      if (picked === setup) await vscode.commands.executeCommand('interlinear.setup');
      if (picked === showLog) server.output.show();
      if (picked === openSettings) await vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.endpoint`);
    }),
    vscode.commands.registerCommand('interlinear.clearCache', async () => {
      const n = cache.size;
      cache.clear();
      await cache.flush();
      status.update();
      void vscode.window.showInformationMessage(vscode.l10n.t('Cleared the translation cache ({0} entries)', n));
    }),
    vscode.commands.registerCommand('interlinear.showMenu', async () => {
      const managed = config.serverMode === 'managed';
      const items: Array<vscode.QuickPickItem & { command: string; args?: unknown[] }> = [
        {
          label: config.enabled ? `$(circle-slash) ${vscode.l10n.t('Disable Translation')}` : `$(check) ${vscode.l10n.t('Enable Translation')}`,
          command: 'interlinear.toggle',
        },
        {
          label:
            config.inlineTranslation === 'off'
              ? `$(eye) ${vscode.l10n.t('Show Translations Beside Comments')}`
              : `$(eye-closed) ${vscode.l10n.t('Hide Translations Beside Comments')}`,
          command: 'interlinear.toggleInline',
        },
        ...(managed
          ? [
              {
                label: `$(cloud-download) ${vscode.l10n.t('Set Up or Change Translation Model')}`,
                description: config.model,
                command: 'interlinear.setup',
              },
              { label: `$(debug-restart) ${vscode.l10n.t('Restart Translation Server')}`, command: 'interlinear.restartServer' },
              { label: `$(output) ${vscode.l10n.t('Show Translation Server Log')}`, command: 'interlinear.showServerLog' },
            ]
          : [
              {
                label: `$(plug) ${vscode.l10n.t('Check Translation Server Connection')}`,
                description: config.endpoint,
                command: 'interlinear.checkServer',
              },
            ]),
        {
          label: `$(trash) ${vscode.l10n.t('Clear Translation Cache')}`,
          description: vscode.l10n.t('{0} entries', cache.size),
          command: 'interlinear.clearCache',
        },
        {
          label: `$(gear) ${vscode.l10n.t('Open Settings')}`,
          command: 'workbench.action.openSettings',
          args: [`@ext:${context.extension.id}`],
        },
      ];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Interlinear' });
      if (picked) await vscode.commands.executeCommand(picked.command, ...(picked.args ?? []));
    }),
  );

  return { service, index, server, inlineLines: (uri) => inline.shownLines(uri) };
}

export function deactivate(): Promise<void> | undefined {
  return onDeactivate?.();
}
