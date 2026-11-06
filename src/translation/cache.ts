/**
 * 翻訳結果のキャッシュ（LRU）。JSON ファイルに永続化できる。
 * キーはプロンプト全体とモデル名のハッシュなので、原文・言語・context・用語集・モデルのどれが変わっても別のキーになる。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FILE_VERSION = 1;

interface CacheFile {
  version: number;
  entries: Array<[string, string]>;
}

export interface TranslationCacheOptions {
  maxEntries: number;
  /** 永続化先。省略するとメモリのみ */
  file?: string;
  /** 変更後、保存するまでの待ち時間（ms） */
  saveDelayMs?: number;
}

export class TranslationCache {
  /** Map の挿入順を LRU の順序として使う（末尾が最新） */
  private readonly map = new Map<string, string>();
  private readonly opts: Required<Omit<TranslationCacheOptions, 'file'>> & { file?: string };
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(opts: TranslationCacheOptions) {
    this.opts = { saveDelayMs: 5000, ...opts };
  }

  static key(model: string, prompt: string): string {
    return createHash('sha256').update(model).update('\u0000').update(prompt).digest('hex');
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): string | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: string): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.opts.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.markDirty();
  }

  clear(): void {
    this.map.clear();
    this.markDirty();
  }

  /** 永続化ファイルを読み込む。壊れている・存在しない場合は空のまま */
  async load(): Promise<void> {
    if (!this.opts.file) return;
    let data: CacheFile;
    try {
      data = JSON.parse(await readFile(this.opts.file, 'utf8')) as CacheFile;
    } catch {
      return;
    }
    if (data.version !== FILE_VERSION || !Array.isArray(data.entries)) return;
    // 読み込みより前に set されたものを新しい扱いにする
    const newer = [...this.map];
    this.map.clear();
    for (const [k, v] of data.entries) {
      if (typeof k === 'string' && typeof v === 'string') this.map.set(k, v);
    }
    for (const [k, v] of newer) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    while (this.map.size > this.opts.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** 変更があれば保存する（書き込み途中で落ちても壊れないよう、一時ファイルに書いてから置き換える） */
  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const file = this.opts.file;
    if (!file || !this.dirty) return this.saving;
    this.dirty = false;
    const body: CacheFile = { version: FILE_VERSION, entries: [...this.map] };
    this.saving = this.saving
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(body));
        await rename(tmp, file);
      })
      .catch(() => {
        // 保存に失敗してもメモリ上のキャッシュはそのまま使える
        this.dirty = true;
      });
    return this.saving;
  }

  dispose(): Promise<void> {
    return this.flush();
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.opts.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, this.opts.saveDelayMs);
    this.saveTimer.unref?.();
  }
}
