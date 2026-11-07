/**
 * 自動管理モードでダウンロードするファイル。バージョンと SHA-256 を固定し、ダウンロード後に必ず照合する。
 * 実行時に API からハッシュを取らないのは、配布元が書き換えられた場合に、その内容をそのまま信じてしまうため。
 *
 * 更新するときは `npm run check:manifest` で URL とサイズを確かめる。
 */
import * as l10n from '@vscode/l10n';

export const LLAMA_BUILD = 'b11700';

export interface DownloadAsset {
  url: string;
  /** ファイル名（保存時に使う） */
  name: string;
  bytes: number;
  sha256: string;
}

export interface LlamaAsset extends DownloadAsset {
  /**
   * Linux 版が要求する glibc の最低バージョン。これより古い環境では共有ライブラリを読み込めず、起動直後に終了する。
   * llama.cpp のビルドを更新したら、展開したファイルを `readelf -V` で調べて確かめ直す（arm64 と x64 でビルド環境が違う）。
   */
  minGlibc?: string;
}

const llama = (name: string, bytes: number, sha256: string, minGlibc?: string): LlamaAsset => ({
  url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${name}`,
  name,
  bytes,
  sha256,
  ...(minGlibc ? { minGlibc } : {}),
});

/**
 * `${process.platform}-${process.arch}` → llama.cpp のビルド済みファイル。
 * Linux と Windows は CPU 版にしている。GPU 版（CUDA / Vulkan）はドライバやランタイムが揃っていないと起動すらしないため。
 * GPU を使いたい場合は、自分で入れた llama-server を設定 `interlinear.server.llamaServerPath` で指定する。
 */
export const LLAMA_ASSETS: Readonly<Record<string, LlamaAsset>> = {
  'darwin-arm64': llama('llama-b11700-bin-macos-arm64.tar.gz', 12231542, '75d795f8826e09893d44e040742ca5dd604d9402dc40393aed0aea6866aadd73'),
  'darwin-x64': llama('llama-b11700-bin-macos-x64.tar.gz', 11715425, '957911e205758c5ffc5e835e631dd428ba7a46c91f8824e3a3e1a2f107aa7c79'),
  'linux-arm64': llama('llama-b11700-bin-ubuntu-arm64.tar.gz', 13941475, '375b442c3373df5929b3ebf9260d0b955e341bd86bda4e3be9d4cb8a0edd633e', '2.38'),
  'linux-x64': llama('llama-b11700-bin-ubuntu-x64.tar.gz', 17891256, '51842656431fc20928123e0c88598f7604a2fe2031fb4e7d45943316817de024', '2.34'),
  'win32-arm64': llama('llama-b11700-bin-win-cpu-arm64.zip', 12484011, '97d76ec70354f070e122954ffdb0912dca37efe9e3d85b1b164c39c9c55a9a7d'),
  'win32-x64': llama('llama-b11700-bin-win-cpu-x64.zip', 19593035, '4e2af6b2b39691cd84267a02839596ed6653ea2dde5ee9cdbfeb4dd9677eecbb'),
};

export function platformKey(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export function llamaAssetFor(key: string = platformKey()): LlamaAsset | undefined {
  return LLAMA_ASSETS[key];
}

/**
 * ビルド済みの llama.cpp がこの環境で動かない理由。動くなら undefined。
 * 起動直後に終了してからでは、利用者には「異常終了した」としか伝わらないため、ダウンロードや起動の前に確かめる。
 * libstdc++ も新しいものが要るが、Node から版を知る手段がない。glibc が足りるディストリなら、たいてい libstdc++ も足りる。
 *
 * @param glibc 実行中の glibc のバージョン。glibc を使わない Linux（Alpine などの musl）なら undefined
 */
export function llamaIncompatibility(asset: LlamaAsset, glibc: string | undefined): string | undefined {
  if (!asset.minGlibc) return undefined;
  if (!glibc) {
    return l10n.t('The automatically installed llama.cpp is built for glibc-based Linux and does not run in this environment (musl, such as Alpine)');
  }
  if (compareVersions(glibc, asset.minGlibc) < 0) {
    return l10n.t('The automatically installed llama.cpp requires glibc {0} or later (this environment has {1})', asset.minGlibc, glibc);
  }
  return undefined;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export type ModelSize = '0.8b' | '2b' | '8b';
export const MODEL_SIZES: readonly ModelSize[] = ['0.8b', '2b', '8b'];

export interface ModelInfo extends DownloadAsset {
  size: ModelSize;
  /** パラメーター数（例: 2B） */
  label: string;
}

/** Hugging Face のコミットを指定した URL にして、同じ名前のファイルが差し替えられても影響を受けないようにする */
const model = (size: ModelSize, revision: string, bytes: number, sha256: string): ModelInfo => {
  const name = `plamo-3-translate-${size}-Q4_K_M.gguf`;
  return {
    size,
    url: `https://huggingface.co/pfnet/plamo-3-translate-${size}-GGUF/resolve/${revision}/${name}`,
    name,
    bytes,
    sha256,
    label: size.toUpperCase(),
  };
};

export const MODELS: Readonly<Record<ModelSize, ModelInfo>> = {
  '0.8b': model('0.8b', 'dbeb0856cb0b004b484f190bb71dd65876297013', 573123200, '923b2f28a9856de1b8b3b610a7e59ded0b14d007466fd5dd526e6a9ecaadafdd'),
  '2b': model('2b', '232fbd7916519edecddfdae0beae7e76fe70453f', 1807199392, 'f36d0813dd95573a852ab5d76e374c543632d9e292929e922bcdbf7e53b494e0'),
  '8b': model('8b', '2234f168757f570714b333049c9d018161ec5277', 5280442080, '47a04e86a67bcc352fa186f01159060aae594b73993e1d49dbfc0ef0081d01ad'),
};

export const LICENSE_URL = 'https://plamo.preferredai.jp/info/plamo-community-license-ja';
/** 同意を記録するときの版。条件が変わったら上げて、同意を取り直す */
export const LICENSE_CONSENT_VERSION = 'plamo-community-license-2026-11';
