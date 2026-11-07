/**
 * 自動管理モードのファイル配置（拡張の globalStorage の下）。
 *
 *   <root>/llama.cpp/<ビルド>-<プラットフォーム>/…/llama-server
 *   <root>/models/plamo-3-translate-<サイズ>-Q4_K_M.gguf
 *   <root>/downloads/                                    ダウンロード途中のファイル
 */
import { rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import * as l10n from '@vscode/l10n';
import { downloadVerified, ensureFreeSpace, extractArchive, findFile, type DownloadOptions } from './download.ts';
import { LLAMA_BUILD, MODELS, llamaAssetFor, llamaIncompatibility, platformKey, type LlamaAsset, type ModelSize } from './manifest.ts';

const SERVER_NAMES = ['llama-server', 'llama-server.exe'];

/** 実行中の glibc のバージョン。Linux 以外や、glibc を使わない Linux では undefined */
function runtimeGlibc(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  return report.header?.glibcVersionRuntime;
}

export class Installer {
  readonly root: string;
  private readonly platform: string;
  private readonly llamaAsset: LlamaAsset | undefined;
  private readonly glibc: () => string | undefined;

  constructor(
    root: string,
    platform: string = platformKey(),
    llamaAsset: LlamaAsset | undefined = llamaAssetFor(platform),
    glibc: () => string | undefined = runtimeGlibc,
  ) {
    this.root = root;
    this.platform = platform;
    this.llamaAsset = llamaAsset;
    this.glibc = glibc;
  }

  /** 自動で入れる llama.cpp をこの環境で使えない理由。使えるなら undefined */
  get unsupportedReason(): string | undefined {
    if (!this.llamaAsset) return l10n.t('No prebuilt llama.cpp is available for this platform ({0})', this.platform);
    return llamaIncompatibility(this.llamaAsset, this.glibc());
  }

  private get llamaDir(): string {
    return path.join(this.root, 'llama.cpp', `${LLAMA_BUILD}-${this.platform}`);
  }

  modelPath(size: ModelSize): string {
    return path.join(this.root, 'models', MODELS[size].name);
  }

  findLlamaServer(): Promise<string | undefined> {
    return findFile(this.llamaDir, SERVER_NAMES);
  }

  /** サイズまで一致していればダウンロード済みとみなす（ハッシュはダウンロード時に照合済み） */
  async isModelInstalled(size: ModelSize): Promise<boolean> {
    try {
      return (await stat(this.modelPath(size))).size === MODELS[size].bytes;
    } catch {
      return false;
    }
  }

  async installLlama(opts: DownloadOptions = {}): Promise<string> {
    const asset = this.llamaAsset;
    const reason = this.unsupportedReason;
    if (!asset || reason) throw new Error(reason);
    const existing = await this.findLlamaServer();
    if (existing) return existing;
    const downloads = path.join(this.root, 'downloads');
    await ensureFreeSpace(downloads, asset.bytes * 3);
    const archive = path.join(downloads, asset.name);
    await downloadVerified(asset.url, archive, asset.sha256, opts);
    // 途中で失敗しても壊れたディレクトリが残らないよう、別の場所に展開してから移す
    const tmp = `${this.llamaDir}.tmp`;
    await rm(tmp, { recursive: true, force: true });
    try {
      await extractArchive(archive, tmp);
      if (!(await findFile(tmp, SERVER_NAMES))) throw new Error(l10n.t('llama-server was not found in the extracted files: {0}', asset.name));
      await rm(this.llamaDir, { recursive: true, force: true });
      await rename(tmp, this.llamaDir);
    } finally {
      await rm(tmp, { recursive: true, force: true });
      await rm(archive, { force: true });
    }
    const server = await this.findLlamaServer();
    if (!server) throw new Error(l10n.t('Failed to install llama-server'));
    return server;
  }

  async installModel(size: ModelSize, opts: DownloadOptions = {}): Promise<string> {
    const dest = this.modelPath(size);
    if (await this.isModelInstalled(size)) return dest;
    const m = MODELS[size];
    await ensureFreeSpace(path.dirname(dest), m.bytes);
    await downloadVerified(m.url, dest, m.sha256, opts);
    return dest;
  }

  async removeModel(size: ModelSize): Promise<void> {
    await rm(this.modelPath(size), { force: true });
  }
}
