/**
 * 翻訳サーバーの用意（自動管理 / 外部サーバーの切り替え）と、初回セットアップの流れ。
 */
import * as vscode from 'vscode';
import { SECTION, modelLabel, type ExtensionConfig } from '../config.ts';
import { LlamaClient } from '../core/llama-client.ts';
import { formatList } from '../l10n.ts';
import { Installer } from '../managed/installer.ts';
import { ManagedServer, NotReadyError } from '../managed/managedServer.ts';
import {
  LICENSE_CONSENT_VERSION,
  LICENSE_URL,
  MODELS,
  MODEL_SIZES,
  llamaAssetFor,
  type ModelSize,
} from '../managed/manifest.ts';
import type { TranslationBackend } from '../translation/service.ts';

const CONSENT_KEY = 'licenseConsent';
const PROMPT_DISMISSED_KEY = 'setupPromptDismissed';

const unsupportedMessage = (reason: string) =>
  vscode.l10n.t('{0}. Provide your own llama-server and set it in {1}, or use an external server.', reason, `${SECTION}.server.llamaServerPath`);

function modelDetail(size: ModelSize): string {
  switch (size) {
    case '0.8b':
      return vscode.l10n.t('Lightweight. For machines without a GPU. More mistranslations and style inconsistencies than 2B');
    case '2b':
      return vscode.l10n.t('Recommended. Under 1 second per comment on Apple Silicon');
    case '8b':
      return vscode.l10n.t('Highest quality. Takes about 3 times as long as 2B. For machines with plenty of memory');
  }
}

export class ServerController implements vscode.Disposable {
  readonly output: vscode.LogOutputChannel;
  readonly installer: Installer;
  private readonly context: vscode.ExtensionContext;
  private managed: ManagedServer | undefined;
  private needsSetupValue = false;
  private readonly listeners = new Set<() => void>();
  private prompted = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.output = vscode.window.createOutputChannel('Interlinear', { log: true });
    this.installer = new Installer(context.globalStorageUri.fsPath);
  }

  /** 自動管理モードで、まだモデルなどが用意されていない */
  get needsSetup(): boolean {
    return this.needsSetupValue;
  }

  onDidChange(listener: () => void): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** 設定に合ったサーバーを作る。前に作った自動管理のサーバーは止める */
  createBackend(c: ExtensionConfig): TranslationBackend {
    void this.managed?.dispose();
    this.managed = undefined;
    if (c.serverMode === 'external') return new LlamaClient(c.endpoint);
    const managed = new ManagedServer({
      serverPath: async () => {
        if (c.llamaServerPath) return c.llamaServerPath;
        // セットアップ時にも確かめるが、それより前の版でダウンロード済みのものは、起動しては異常終了を繰り返してしまう
        const unsupported = this.installer.unsupportedReason;
        if (unsupported) throw new NotReadyError(unsupportedMessage(unsupported));
        return this.installer.findLlamaServer();
      },
      modelPath: async () =>
        c.modelPath || ((await this.installer.isModelInstalled(c.model)) ? this.installer.modelPath(c.model) : undefined),
      parallel: c.maxConcurrentRequests,
      idleTimeoutMs: c.idleTimeoutMinutes * 60_000,
      log: (line) => this.output.info(line),
    });
    this.managed = managed;
    return managed;
  }

  async isReady(c: ExtensionConfig): Promise<boolean> {
    if (c.serverMode === 'external') return true;
    const server = c.llamaServerPath || (await this.installer.findLlamaServer());
    const model = c.modelPath || ((await this.installer.isModelInstalled(c.model)) ? 'ok' : '');
    return Boolean(server && model);
  }

  async refreshSetupState(c: ExtensionConfig): Promise<void> {
    const next = c.serverMode === 'managed' && !(await this.isReady(c));
    if (next !== this.needsSetupValue) {
      this.needsSetupValue = next;
      for (const l of this.listeners) l();
    }
  }

  /** 自動管理のサーバーを起動し直す（外部サーバーなら何もしない） */
  async restart(): Promise<void> {
    await this.managed?.restart();
  }

  /** 起動時に一度だけ、セットアップが必要なことを知らせる */
  async promptIfNeeded(c: ExtensionConfig): Promise<void> {
    if (this.prompted || !c.enabled || !this.needsSetupValue) return;
    if (this.context.globalState.get<boolean>(PROMPT_DISMISSED_KEY)) return;
    this.prompted = true;
    const setup = vscode.l10n.t('Set Up');
    const external = vscode.l10n.t('Use External Server');
    const never = vscode.l10n.t("Don't Show Again");
    const picked = await vscode.window.showInformationMessage(
      vscode.l10n.t('Translating comments requires downloading a translation model ({0}).', modelLabel(c.model)),
      setup,
      external,
      never,
    );
    if (picked === setup) await vscode.commands.executeCommand('interlinear.setup');
    if (picked === external) {
      await vscode.workspace.getConfiguration(SECTION).update('server.mode', 'external', vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.endpoint`);
    }
    if (picked === never) await this.context.globalState.update(PROMPT_DISMISSED_KEY, true);
  }

  /**
   * セットアップ: モデルを選び、ライセンスに同意してもらい、llama.cpp とモデルをダウンロードする。
   * 完了したら true。
   */
  async runSetup(c: ExtensionConfig): Promise<boolean> {
    const unsupported = c.llamaServerPath ? undefined : this.installer.unsupportedReason;
    if (unsupported) {
      void vscode.window.showErrorMessage(unsupportedMessage(unsupported));
      return false;
    }

    const items = await Promise.all(
      MODEL_SIZES.map(async (size) => ({
        label: size === '2b' ? vscode.l10n.t('{0} — Recommended', modelLabel(size)) : modelLabel(size),
        description: (await this.installer.isModelInstalled(size)) ? vscode.l10n.t('Downloaded') : '',
        detail: modelDetail(size),
        picked: size === c.model,
        size,
      })),
    );
    const pick = c.modelPath
      ? undefined
      : await vscode.window.showQuickPick(items, {
          title: vscode.l10n.t('Interlinear: Choose a Translation Model'),
          placeHolder: vscode.l10n.t('Larger models translate better, but are slower and use more memory'),
        });
    if (!c.modelPath && !pick) return false;
    const size: ModelSize = pick?.size ?? c.model;

    if (!(await this.ensureConsent())) return false;

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Interlinear Setup'), cancellable: true },
        async (progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          const llama = c.llamaServerPath || (await this.installer.findLlamaServer()) ? undefined : llamaAssetFor();
          const model = c.modelPath || (await this.installer.isModelInstalled(size)) ? undefined : MODELS[size];
          const total = (llama?.bytes ?? 0) + (model?.bytes ?? 0);
          let done = 0;
          const mb = (n: number) => (n / 1e6).toFixed(0);
          const report = (message: (received: string) => string, base: number) => (p: { received: number }) => {
            const now = base + p.received;
            progress.report({
              message: message(mb(p.received)),
              increment: total > 0 ? ((now - done) / total) * 100 : undefined,
            });
            done = now;
          };
          if (llama) {
            this.output.info(`Downloading ${llama.url}`);
            await this.installer.installLlama({
              signal: abort.signal,
              onProgress: report((received) => vscode.l10n.t('Downloading llama.cpp… {0} / {1} MB', received, mb(llama.bytes)), 0),
            });
          }
          if (model) {
            this.output.info(`Downloading ${model.url}`);
            await this.installer.installModel(size, {
              signal: abort.signal,
              onProgress: report(
                (received) =>
                  vscode.l10n.t('Downloading the translation model ({0})… {1} / {2} MB', modelLabel(size), received, mb(model.bytes)),
                llama?.bytes ?? 0,
              ),
            });
          }
        },
      );
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        void vscode.window.showInformationMessage(vscode.l10n.t('Setup canceled'));
        return false;
      }
      const message = e instanceof Error ? e.message : String(e);
      this.output.error(message);
      void vscode.window.showErrorMessage(vscode.l10n.t('Setup failed: {0}', message));
      return false;
    }

    const config = vscode.workspace.getConfiguration(SECTION);
    if (size !== c.model) await config.update('server.model', size, vscode.ConfigurationTarget.Global);
    if (c.serverMode !== 'managed') await config.update('server.mode', 'managed', vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(vscode.l10n.t('Setup complete. Hover over a comment to see its translation.'));
    return true;
  }

  /** ダウンロード済みのモデルを選んで削除する（8B は 5 GB あるので、使わなくなったら消せるようにする） */
  async removeModels(c: ExtensionConfig): Promise<ModelSize[]> {
    const installed: ModelSize[] = [];
    for (const size of MODEL_SIZES) if (await this.installer.isModelInstalled(size)) installed.push(size);
    if (installed.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No models have been downloaded'));
      return [];
    }
    const picks = await vscode.window.showQuickPick(
      installed.map((size) => ({ label: modelLabel(size), description: size === c.model ? vscode.l10n.t('In use') : '', size })),
      { canPickMany: true, title: vscode.l10n.t('Choose Models to Remove') },
    );
    if (!picks || picks.length === 0) return [];
    const ok = vscode.l10n.t('Remove');
    const confirm = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Remove {0}? To use a removed model again, you will need to download it again.',
        formatList(picks.map((p) => p.label)),
      ),
      { modal: true },
      ok,
    );
    if (confirm !== ok) return [];
    if (picks.some((p) => p.size === c.model)) await this.managed?.stop();
    for (const p of picks) await this.installer.removeModel(p.size);
    return picks.map((p) => p.size);
  }

  private async ensureConsent(): Promise<boolean> {
    if (this.context.globalState.get<string>(CONSENT_KEY) === LICENSE_CONSENT_VERSION) return true;
    const accept = vscode.l10n.t('Agree and Download');
    const read = vscode.l10n.t('Read License');
    const paragraphs = [
      [
        vscode.l10n.t('The translation model PLaMo 3 Translate (Preferred Networks) is provided under the PLaMo Community License.'),
        vscode.l10n.t('• Personal use and non-commercial use, including academic use: free, no registration required'),
        vscode.l10n.t('• Commercial use: prior registration required (a separate agreement is required if revenue exceeds JPY 1 billion)'),
      ].join('\n'),
      vscode.l10n.t(
        'Files are downloaded from Hugging Face (pfnet) and GitHub (llama.cpp) and verified with SHA-256. Translation runs on this computer, and your code is never sent anywhere.',
      ),
    ];
    // リモートのウィンドウでも、拡張がローカル側（ui）で動いていれば翻訳もローカルで行う
    if (vscode.env.remoteName && this.context.extension.extensionKind === vscode.ExtensionKind.Workspace) {
      paragraphs.push(
        vscode.l10n.t(
          'This extension is running in the remote environment ({0}), so the model is stored and translation runs on the remote side. It will be slow without a GPU (if you run llama-server on the host, you can use it as an external server).',
          vscode.env.remoteName,
        ),
      );
    }
    for (;;) {
      const picked = await vscode.window.showInformationMessage(
        vscode.l10n.t('Translation Model License Agreement'),
        { modal: true, detail: paragraphs.join('\n\n') },
        accept,
        read,
      );
      if (picked === read) {
        await vscode.env.openExternal(vscode.Uri.parse(LICENSE_URL));
        continue;
      }
      if (picked !== accept) return false;
      await this.context.globalState.update(CONSENT_KEY, LICENSE_CONSENT_VERSION);
      return true;
    }
  }

  async dispose(): Promise<void> {
    await this.managed?.dispose();
    this.output.dispose();
  }
}
