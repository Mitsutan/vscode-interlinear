import * as vscode from 'vscode';
import { defaultTargetLanguage } from './core/language.ts';
import type { GlossaryEntry } from './core/pfml3.ts';
import type { InlineMode } from './editor/inlineDecorator.ts';
import { MODELS, MODEL_SIZES, type ModelSize } from './managed/manifest.ts';
import type { TranslatorSettings } from './translation/service.ts';

export const SECTION = 'interlinear';

/** managed: 拡張が llama-server を起動・管理する / external: interlinear.endpoint のサーバーを使う */
export type ServerMode = 'managed' | 'external';

export interface ExtensionConfig {
  enabled: boolean;
  translateDocumentation: boolean;
  inlineTranslation: InlineMode;
  inlineMaxWidth: number;
  serverMode: ServerMode;
  model: ModelSize;
  idleTimeoutMinutes: number;
  llamaServerPath: string;
  modelPath: string;
  endpoint: string;
  targetLang: string;
  sourceLang: string;
  form: 'plain' | 'polite' | 'none';
  useContext: boolean;
  glossary: GlossaryEntry[];
  prefetch: boolean;
  maxConcurrentRequests: number;
}

/**
 * 利用者が明示的に設定したか。信頼されていないワークスペースの値は数えない。
 * VS Code は get() では制限付きの設定のワークスペースの値を無視するが、inspect() では返すため。
 */
function isExplicit(i: { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined): boolean {
  if (i === undefined) return false;
  const values = vscode.workspace.isTrusted ? [i.globalValue, i.workspaceValue, i.workspaceFolderValue] : [i.globalValue];
  return values.some((v) => v !== undefined);
}

export function readConfig(): ExtensionConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  const glossary = c.get<unknown[]>('glossary', []).filter(
    (g): g is GlossaryEntry =>
      typeof g === 'object' && g !== null && typeof (g as GlossaryEntry).source === 'string' && typeof (g as GlossaryEntry).target === 'string',
  );
  // モードを明示していなければ、エンドポイントを設定済みの人（自動管理ができる前からの利用者）は外部サーバーとして扱う
  const serverMode: ServerMode = isExplicit(c.inspect('server.mode'))
    ? c.get<ServerMode>('server.mode', 'managed')
    : isExplicit(c.inspect('endpoint'))
      ? 'external'
      : 'managed';
  const model = c.get<string>('server.model', '2b');
  return {
    enabled: c.get('enabled', true),
    translateDocumentation: c.get('translateDocumentation', true),
    inlineTranslation: c.get<InlineMode>('inlineTranslation', 'short'),
    inlineMaxWidth: Math.max(40, Math.floor(c.get('inlineMaxWidth', 120))),
    serverMode,
    model: (MODEL_SIZES as readonly string[]).includes(model) ? (model as ModelSize) : '2b',
    idleTimeoutMinutes: Math.max(0, c.get('server.idleTimeoutMinutes', 15)),
    llamaServerPath: c.get('server.llamaServerPath', '').trim(),
    modelPath: c.get('server.modelPath', '').trim(),
    endpoint: c.get('endpoint', 'http://127.0.0.1:18080').trim(),
    targetLang: c.get('targetLanguage', '').trim() || defaultTargetLanguage(vscode.env.language),
    sourceLang: c.get('sourceLanguage', '').trim(),
    form: c.get('form', 'plain'),
    useContext: c.get('useContext', true),
    glossary,
    prefetch: c.get('prefetch', true),
    maxConcurrentRequests: Math.max(1, Math.floor(c.get('maxConcurrentRequests', 2))),
  };
}

/** 画面に出すモデルの名前（例: 2B (1.8 GB)） */
export function modelLabel(size: ModelSize): string {
  const m = MODELS[size];
  return vscode.l10n.t('{0} ({1} GB)', m.label, (m.bytes / 1e9).toFixed(1));
}

/** エラーメッセージなどに出す、サーバーの呼び名 */
export function serverLabel(c: ExtensionConfig): string {
  if (c.serverMode === 'external') return c.endpoint;
  return vscode.l10n.t('Managed: {0}', c.modelPath || modelLabel(c.model));
}

export function toTranslatorSettings(c: ExtensionConfig): TranslatorSettings {
  return {
    endpoint: serverLabel(c),
    targetLang: c.targetLang,
    sourceLang: c.sourceLang || undefined,
    form: c.form === 'none' ? undefined : c.form,
    useContext: c.useContext,
    glossary: c.glossary,
  };
}

/** 翻訳サーバー（の作り方）が変わったか。変わったらサーバーを作り直す */
export function backendKey(c: ExtensionConfig): string {
  return c.serverMode === 'external'
    ? JSON.stringify(['external', c.endpoint])
    : JSON.stringify(['managed', c.model, c.llamaServerPath, c.modelPath, c.idleTimeoutMinutes, c.maxConcurrentRequests]);
}

/** 翻訳結果に影響する設定が変わったか（変わったら待機中のリクエストを捨てて接続を確認し直す） */
export function affectsTranslation(a: ExtensionConfig, b: ExtensionConfig): boolean {
  return backendKey(a) !== backendKey(b) || JSON.stringify(toTranslatorSettings(a)) !== JSON.stringify(toTranslatorSettings(b));
}
