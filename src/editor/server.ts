/**
 * 翻訳サーバーの用意（自動管理 / 外部サーバーの切り替え）と、初回セットアップの流れ。
 */
import * as vscode from 'vscode';
import { SECTION, type ExtensionConfig } from '../config.ts';
import { LlamaClient } from '../core/llama-client.ts';
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
  `${reason}。llama-server を用意して設定 ${SECTION}.server.llamaServerPath で指定するか、外部サーバーを使ってください`;

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
    const setup = 'セットアップ';
    const external = '外部サーバーを使う';
    const never = '今後表示しない';
    const picked = await vscode.window.showInformationMessage(
      `コメントを翻訳するには、翻訳モデル（${MODELS[c.model].label}）のダウンロードが必要です。`,
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
      void vscode.window.showErrorMessage(`${unsupportedMessage(unsupported)}。`);
      return false;
    }

    const items = await Promise.all(
      MODEL_SIZES.map(async (size) => ({
        label: `${MODELS[size].label}${size === '2b' ? '　推奨' : ''}`,
        description: (await this.installer.isModelInstalled(size)) ? 'ダウンロード済み' : '',
        detail: MODELS[size].detail,
        picked: size === c.model,
        size,
      })),
    );
    const pick = c.modelPath
      ? undefined
      : await vscode.window.showQuickPick(items, { title: 'Interlinear: 翻訳モデルを選ぶ', placeHolder: '大きいほど訳は良くなりますが、遅く、メモリも多く使います' });
    if (!c.modelPath && !pick) return false;
    const size: ModelSize = pick?.size ?? c.model;

    if (!(await this.ensureConsent())) return false;

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Interlinear のセットアップ', cancellable: true },
        async (progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          const llama = c.llamaServerPath || (await this.installer.findLlamaServer()) ? undefined : llamaAssetFor();
          const model = c.modelPath || (await this.installer.isModelInstalled(size)) ? undefined : MODELS[size];
          const total = (llama?.bytes ?? 0) + (model?.bytes ?? 0);
          let done = 0;
          const report = (label: string, base: number, bytes: number) => (p: { received: number }) => {
            const now = base + p.received;
            progress.report({
              message: `${label}をダウンロード中… ${(p.received / 1e6).toFixed(0)} / ${(bytes / 1e6).toFixed(0)} MB`,
              increment: total > 0 ? ((now - done) / total) * 100 : undefined,
            });
            done = now;
          };
          if (llama) {
            this.output.info(`ダウンロード: ${llama.url}`);
            await this.installer.installLlama({ signal: abort.signal, onProgress: report('llama.cpp ', 0, llama.bytes) });
          }
          if (model) {
            this.output.info(`ダウンロード: ${model.url}`);
            await this.installer.installModel(size, {
              signal: abort.signal,
              onProgress: report(`翻訳モデル（${model.label}）`, llama?.bytes ?? 0, model.bytes),
            });
          }
        },
      );
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        void vscode.window.showInformationMessage('セットアップを取り消しました');
        return false;
      }
      const message = e instanceof Error ? e.message : String(e);
      this.output.error(message);
      void vscode.window.showErrorMessage(`セットアップに失敗しました: ${message}`);
      return false;
    }

    const config = vscode.workspace.getConfiguration(SECTION);
    if (size !== c.model) await config.update('server.model', size, vscode.ConfigurationTarget.Global);
    if (c.serverMode !== 'managed') await config.update('server.mode', 'managed', vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage('セットアップが完了しました。コメントにマウスを置くと訳文が表示されます。');
    return true;
  }

  /** ダウンロード済みのモデルを選んで削除する（8B は 5 GB あるので、使わなくなったら消せるようにする） */
  async removeModels(c: ExtensionConfig): Promise<ModelSize[]> {
    const installed: ModelSize[] = [];
    for (const size of MODEL_SIZES) if (await this.installer.isModelInstalled(size)) installed.push(size);
    if (installed.length === 0) {
      void vscode.window.showInformationMessage('ダウンロード済みのモデルはありません');
      return [];
    }
    const picks = await vscode.window.showQuickPick(
      installed.map((size) => ({ label: MODELS[size].label, description: size === c.model ? '使用中' : '', size })),
      { canPickMany: true, title: '削除するモデルを選ぶ' },
    );
    if (!picks || picks.length === 0) return [];
    const ok = '削除する';
    const confirm = await vscode.window.showWarningMessage(
      `${picks.map((p) => p.label).join('、')} を削除しますか？もう一度使うにはダウンロードし直す必要があります。`,
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
    const accept = '同意してダウンロード';
    const read = 'ライセンスを読む';
    // リモートのウィンドウでも、拡張がローカル側（ui）で動いていれば翻訳もローカルで行う
    const remote =
      vscode.env.remoteName && this.context.extension.extensionKind === vscode.ExtensionKind.Workspace
        ? `\n\nこの拡張はリモート環境（${vscode.env.remoteName}）で動いているため、モデルはリモート側に保存され、翻訳もリモート側で行います。GPU を使えない環境では遅くなります（ホストで llama-server を動かしている場合は、外部サーバーを使う設定にできます）。`
        : '';
    for (;;) {
      const picked = await vscode.window.showInformationMessage(
        '翻訳モデルのライセンスへの同意',
        {
          modal: true,
          detail:
            '翻訳モデル PLaMo 3 Translate（Preferred Networks）は PLaMo Community License で提供されています。\n' +
            '・個人利用、学術を含む非商用利用: 無償、登録不要\n' +
            '・商用利用: 事前の登録が必要（売上 10 億円超は別途契約）\n\n' +
            'ダウンロード元は Hugging Face（pfnet）と GitHub（llama.cpp）で、ファイルは SHA-256 で検証します。' +
            '翻訳はこのコンピューター上で行い、コードを外部に送信しません。' +
            remote,
        },
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
