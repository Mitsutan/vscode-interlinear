/**
 * 翻訳単位（コメント1つ、またはホバーのドキュメント1つ）を訳す。段落（prose ブロック）ごとにキャッシュを引き、
 * 足りない段落だけをキュー経由で llama-server に投げ、訳文を元の構造に組み戻す。
 */
import * as l10n from '@vscode/l10n';
import { buildContext, type TranslatableText } from '../core/context.ts';
import type { ProbeResult } from '../core/llama-client.ts';
import { reassemble } from '../core/normalize.ts';
import { buildPrompt, type GlossaryEntry, type TranslateRequest } from '../core/pfml3.ts';
import { TranslationCache } from './cache.ts';
import { CancelledError, Priority, type TaskHandle, TaskQueue } from './queue.ts';

/** LlamaClient が満たすインターフェース（テストで差し替えるため） */
export interface TranslationBackend {
  translate(req: TranslateRequest, opts?: { signal?: AbortSignal }): Promise<{ text: string }>;
  probe(): Promise<ProbeResult>;
}

function downMessage(probe: Exclude<ProbeResult, { status: 'ok' }>, endpoint: string): string {
  switch (probe.status) {
    case 'loading':
      return l10n.t('The translation server ({0}) is loading the model', endpoint);
    case 'not-llama':
      return l10n.t('The server responding at {0} is not llama-server (another app may be using this port)', endpoint);
    case 'unreachable':
      return l10n.t('Cannot connect to the translation server ({0})', endpoint);
    case 'unavailable':
      return probe.message;
  }
}

export interface TranslatorSettings {
  /** 表示用（エラーメッセージなど） */
  endpoint: string;
  targetLang: string;
  sourceLang?: string;
  form?: 'plain' | 'polite';
  useContext: boolean;
  glossary: readonly GlossaryEntry[];
}

export type ServerState =
  | { status: 'unknown' }
  | { status: 'ok'; model: string }
  | { status: 'down'; message: string };

export class ServerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerUnavailableError';
  }
}

/** モデル名を確認し直す間隔 */
const OK_RECHECK_MS = 60_000;
/** 接続できないとき、先読みのリクエストを止めておく時間 */
const DOWN_RECHECK_MS = 30_000;

export class TranslationService {
  private backend: TranslationBackend;
  private settings: TranslatorSettings;
  private state: ServerState = { status: 'unknown' };
  private lastCheck = 0;
  private checking: { generation: number; promise: Promise<ServerState> } | undefined;
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  private readonly translatedListeners = new Set<() => void>();
  readonly cache: TranslationCache;
  readonly queue: TaskQueue;
  private readonly now: () => number;

  constructor(
    backend: TranslationBackend,
    settings: TranslatorSettings,
    cache: TranslationCache,
    queue: TaskQueue,
    now: () => number = Date.now,
  ) {
    this.backend = backend;
    this.settings = settings;
    this.cache = cache;
    this.queue = queue;
    this.now = now;
  }

  get serverState(): ServerState {
    return this.state;
  }

  get currentSettings(): TranslatorSettings {
    return this.settings;
  }

  /** 段落の翻訳が終わってキャッシュに入ったとき（行末表示を更新するため） */
  onDidTranslate(listener: () => void): { dispose(): void } {
    this.translatedListeners.add(listener);
    return { dispose: () => this.translatedListeners.delete(listener) };
  }

  onDidChangeState(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** 設定やサーバーが変わったら、待機中のリクエストを捨てて接続を確認し直す */
  reconfigure(backend: TranslationBackend, settings: TranslatorSettings): void {
    this.backend = backend;
    this.settings = settings;
    this.generation++;
    this.queue.clear();
    this.setState({ status: 'unknown' });
    this.lastCheck = 0;
    void this.checkServer();
  }

  /** サーバーはそのままで設定だけを変える */
  updateSettings(settings: TranslatorSettings): void {
    this.reconfigure(this.backend, settings);
  }

  /**
   * サーバーの状態とモデル名を確認する。同時に呼ばれたら1回にまとめる。
   * 設定変更（reconfigure）の前に始まった確認の結果は使わない。
   */
  checkServer(): Promise<ServerState> {
    const generation = this.generation;
    if (this.checking?.generation === generation) return this.checking.promise;
    const backend = this.backend;
    const endpoint = this.settings.endpoint;
    const promise = (async (): Promise<ServerState> => {
      const probe = await backend.probe();
      const next: ServerState =
        probe.status === 'ok' ? { status: 'ok', model: probe.model } : { status: 'down', message: downMessage(probe, endpoint) };
      if (generation === this.generation) {
        this.lastCheck = this.now();
        this.setState(next);
      }
      return next;
    })().finally(() => {
      if (this.checking?.promise === promise) this.checking = undefined;
    });
    this.checking = { generation, promise };
    return promise;
  }

  /** キャッシュにある段落の訳文（ブロックの番号 → 訳文）。一部の段落だけでも返す */
  peekBlocks(unit: TranslatableText): Map<number, string> {
    const found = new Map<number, string>();
    if (this.state.status !== 'ok') return found;
    const model = this.state.model;
    for (const { index, req } of this.requests(unit)) {
      const hit = this.cache.get(TranslationCache.key(model, buildPrompt(req)));
      if (hit !== undefined) found.set(index, hit);
    }
    return found;
  }

  /** すべての段落がキャッシュにあれば訳文を返す（ホバーを即座に出すため） */
  peek(unit: TranslatableText): string | undefined {
    if (this.state.status !== 'ok') return undefined;
    const model = this.state.model;
    const translations = new Map<number, string>();
    for (const { index, req } of this.requests(unit)) {
      const hit = this.cache.get(TranslationCache.key(model, buildPrompt(req)));
      if (hit === undefined) return undefined;
      translations.set(index, hit);
    }
    return reassemble(unit.blocks, translations);
  }

  /** 翻訳して、元の構造に組み戻す */
  translate(unit: TranslatableText, priority: Priority): TaskHandle<string> {
    const handle = this.translateBlocks(unit, priority);
    const promise = handle.promise.then((translations) => reassemble(unit.blocks, translations));
    promise.catch(() => {});
    return { promise, cancel: handle.cancel };
  }

  /** 段落ごとに翻訳する（ブロックの番号 → 訳文）。キャッシュにない段落だけをサーバーに投げる */
  translateBlocks(unit: TranslatableText, priority: Priority): TaskHandle<Map<number, string>> {
    const handles: TaskHandle<string>[] = [];
    let cancelled = false;
    const promise = (async () => {
      const model = await this.ensureServer(priority);
      if (cancelled) throw new CancelledError();
      const translations = new Map<number, string>();
      const waits: Promise<void>[] = [];
      for (const { index, req } of this.requests(unit)) {
        const key = TranslationCache.key(model, buildPrompt(req));
        const hit = this.cache.get(key);
        if (hit !== undefined) {
          translations.set(index, hit);
          continue;
        }
        const handle = this.queue.run(key, priority, (signal) => this.request(key, req, signal));
        handles.push(handle);
        waits.push(handle.promise.then((text) => void translations.set(index, text)));
      }
      await Promise.all(waits);
      return translations;
    })();
    promise.catch(() => {});
    return {
      promise,
      cancel: () => {
        cancelled = true;
        for (const h of handles) h.cancel();
      },
    };
  }

  private async request(key: string, req: TranslateRequest, signal: AbortSignal): Promise<string> {
    const generation = this.generation;
    try {
      const { text } = await this.backend.translate(req, { signal });
      // 設定が変わった後に返ってきた結果は、古い設定のキーなので保存しても害はないが、状態は更新しない
      this.cache.set(key, text);
      for (const l of this.translatedListeners) l();
      return text;
    } catch (e) {
      // fetch の接続エラーは TypeError("fetch failed") になる。利用者向けの文言に置き換える
      if (e instanceof TypeError && !signal.aborted) {
        const message = l10n.t('Cannot connect to the translation server ({0})', this.settings.endpoint);
        if (generation === this.generation) {
          this.lastCheck = this.now();
          this.setState({ status: 'down', message });
        }
        throw new ServerUnavailableError(message);
      }
      throw e;
    }
  }

  private async ensureServer(priority: Priority): Promise<string> {
    const age = this.now() - this.lastCheck;
    const s = this.state;
    if (s.status === 'ok' && age < OK_RECHECK_MS) return s.model;
    if (s.status === 'down' && priority !== Priority.Interactive && age < DOWN_RECHECK_MS) {
      throw new ServerUnavailableError(s.message);
    }
    const next = await this.checkServer();
    if (next.status === 'ok') return next.model;
    throw new ServerUnavailableError(next.status === 'down' ? next.message : l10n.t('Could not determine the translation server status'));
  }

  private requests(unit: TranslatableText): Array<{ index: number; req: TranslateRequest }> {
    const s = this.settings;
    const context = s.useContext ? buildContext(unit) : undefined;
    return unit.blocks.flatMap((b, index) => {
      if (b.type !== 'prose') return [];
      // 用語集は原文に出てくる語だけを渡す（無関係な用語の追加でキャッシュが無効にならないように）
      const glossary = s.glossary.filter((g) => g.source !== '' && b.text.includes(g.source));
      const req: TranslateRequest = {
        text: b.text,
        targetLang: s.targetLang,
        sourceLang: s.sourceLang || undefined,
        form: s.form,
        context,
        glossary: glossary.length > 0 ? glossary : undefined,
      };
      return [{ index, req }];
    });
  }

  private setState(next: ServerState): void {
    const prev = this.state;
    this.state = next;
    if (JSON.stringify(prev) !== JSON.stringify(next)) for (const l of this.listeners) l();
  }
}
