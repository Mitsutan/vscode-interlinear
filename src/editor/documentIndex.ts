/**
 * ドキュメントごとのコメント（翻訳単位）一覧。ドキュメントのバージョンが変わるまで解析結果を使い回す。
 */
import * as vscode from 'vscode';
import { CommentExtractor } from '../core/extract.ts';
import { normalize, type TranslationUnit } from '../core/normalize.ts';

/** これより大きいファイルは解析しない（生成物や巨大なバンドルを避ける） */
const MAX_CHARS = 2_000_000;

interface Entry {
  version: number;
  targetLang: string;
  units: Promise<TranslationUnit[]>;
}

export class DocumentIndex implements vscode.Disposable {
  private readonly extractor: CommentExtractor;
  private readonly targetLang: () => string;
  private readonly entries = new Map<string, Entry>();
  private readonly subscription: vscode.Disposable;

  constructor(extractor: CommentExtractor, targetLang: () => string) {
    this.extractor = extractor;
    this.targetLang = targetLang;
    this.subscription = vscode.workspace.onDidCloseTextDocument((doc) => this.entries.delete(doc.uri.toString()));
  }

  units(doc: vscode.TextDocument): Promise<TranslationUnit[]> {
    if (!CommentExtractor.supports(doc.languageId)) return Promise.resolve([]);
    const key = doc.uri.toString();
    const targetLang = this.targetLang();
    const cached = this.entries.get(key);
    if (cached && cached.version === doc.version && cached.targetLang === targetLang) return cached.units;

    const text = doc.getText();
    if (text.length > MAX_CHARS) return Promise.resolve([]);
    const units = this.extractor
      .extract(text, doc.languageId, doc.fileName)
      .then((comments) => normalize(comments, { targetLang }));
    const entry: Entry = { version: doc.version, targetLang, units };
    this.entries.set(key, entry);
    units.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return units;
  }

  clear(): void {
    this.entries.clear();
  }

  dispose(): void {
    this.subscription.dispose();
    this.entries.clear();
  }
}
