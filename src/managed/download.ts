/**
 * ダウンロードと展開。ダウンロードしながら SHA-256 を計算し、一致したときだけ置き場所に移す。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export interface DownloadProgress {
  received: number;
  total: number | undefined;
}

export class IntegrityError extends Error {
  constructor(url: string, expected: string, actual: string) {
    super(`ダウンロードしたファイルのハッシュが一致しません（${url}）。期待値 ${expected}、実際 ${actual}`);
    this.name = 'IntegrityError';
  }
}

export interface DownloadOptions {
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
}

export async function downloadVerified(url: string, dest: string, sha256: string, opts: DownloadOptions = {}): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const res = await fetch(url, { signal: opts.signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`ダウンロードに失敗しました（HTTP ${res.status}）: ${url}`);
  const total = Number(res.headers.get('content-length')) || undefined;
  const hash = createHash('sha256');
  const out = createWriteStream(tmp);
  let received = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      opts.onProgress?.({ received, total });
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    const actual = hash.digest('hex');
    if (actual !== sha256) throw new IntegrityError(url, sha256, actual);
    await rename(tmp, dest);
  } catch (e) {
    out.destroy();
    await rm(tmp, { force: true });
    throw e;
  }
}

/** 空き容量が足りるか（取得できない環境では確かめない） */
export async function ensureFreeSpace(dir: string, bytes: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  let free: number;
  try {
    const s = await statfs(dir);
    free = s.bavail * s.bsize;
  } catch {
    return;
  }
  // 展開や一時ファイルの分として 1 割多めに見る
  if (free < bytes * 1.1) {
    const gb = (n: number) => (n / 1e9).toFixed(1);
    throw new Error(`ディスクの空き容量が足りません（必要 ${gb(bytes * 1.1)} GB、空き ${gb(free)} GB）: ${dir}`);
  }
}

/**
 * tar.gz / zip を展開する。OS の tar を使う（macOS・Linux は標準、Windows 10 以降は tar.exe が zip も扱える）。
 * 展開用のライブラリを同梱しないのは、配布サイズと依存を増やしたくないため。
 */
export async function extractArchive(archive: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await promisify(execFile)('tar', ['-xf', archive, '-C', destDir]);
}

/** ディレクトリの下からファイル名で探す */
export async function findFile(dir: string, names: readonly string[]): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (e.isFile() && names.includes(e.name)) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = await findFile(path.join(dir, e.name), names);
      if (found) return found;
    }
  }
  return undefined;
}
