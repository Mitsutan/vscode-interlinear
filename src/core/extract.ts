/**
 * tree-sitter（VS Code 本体と同じ @vscode/tree-sitter-wasm）でコメントと Python の docstring を抽出する。
 * WASM のみで動くので、Extension Host でも Node でも同じコードが動く。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import TreeSitter from '@vscode/tree-sitter-wasm';
import type { Language, Node, Parser } from '@vscode/tree-sitter-wasm';

export type CommentKind = 'line' | 'block' | 'docstring';

export interface RawComment {
  file: string;
  languageId: string;
  kind: CommentKind;
  /** 0 始まり */
  startLine: number;
  endLine: number;
  /** UTF-16 コード単位（VS Code の Position.character と同じ単位） */
  startColumn: number;
  endColumn: number;
  /** 同じ行のコメントより前にコードがある（行末コメント） */
  trailing: boolean;
  text: string;
  /** 翻訳時の context に使う関連コード行（直後の宣言、行末コメントならその行のコード、docstring なら def/class 行） */
  codeLine?: string;
}

/** VS Code の言語 ID → 文法名（esbuild.mjs の GRAMMARS と揃える） */
export const GRAMMAR_BY_LANGUAGE_ID: Readonly<Record<string, string>> = {
  typescript: 'typescript',
  typescriptreact: 'tsx',
  javascript: 'javascript',
  javascriptreact: 'javascript',
  python: 'python',
  go: 'go',
  rust: 'rust',
  java: 'java',
  csharp: 'c-sharp',
  c: 'cpp',
  cpp: 'cpp',
  ruby: 'ruby',
  php: 'php',
  shellscript: 'bash',
  css: 'css',
  powershell: 'powershell',
};

export const SUPPORTED_LANGUAGE_IDS: readonly string[] = Object.keys(GRAMMAR_BY_LANGUAGE_ID);

const LANGUAGE_ID_BY_EXT: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.rb': 'ruby',
  '.php': 'php',
  '.sh': 'shellscript',
  '.bash': 'shellscript',
  '.css': 'css',
  '.ps1': 'powershell',
};

/** 拡張子から言語 ID を推定する（VS Code の外で使う場合用） */
export function languageIdForFile(file: string): string | undefined {
  return LANGUAGE_ID_BY_EXT[path.extname(file).toLowerCase()];
}

function isCommentNode(node: Node): boolean {
  return node.type === 'comment' || node.type.endsWith('_comment');
}

const PY_DEFINITIONS = new Set(['function_definition', 'class_definition']);

/** module / class / def の先頭にある文字列リテラルを docstring とみなす */
function docstringOwner(node: Node): Node | 'module' | undefined {
  if (node.type !== 'string') return undefined;
  const stmt = node.parent;
  if (!stmt || stmt.type !== 'expression_statement' || stmt.namedChildCount !== 1) return undefined;
  const container = stmt.parent;
  if (!container) return undefined;
  const first = container.namedChildren.find((c) => c !== null && !isCommentNode(c));
  if (!first || first.id !== stmt.id) return undefined;
  if (container.type === 'module') return 'module';
  if (container.type === 'block' && container.parent && PY_DEFINITIONS.has(container.parent.type)) {
    return container.parent;
  }
  return undefined;
}

const COMMENT_LINE_START = /^(\/\/|\/\*|\*|#|"""|''')/;

function nextCodeLine(lines: readonly string[], afterLine: number): string | undefined {
  for (let i = afterLine + 1; i < lines.length && i <= afterLine + 5; i++) {
    const t = lines[i]?.trim() ?? '';
    if (t === '' || COMMENT_LINE_START.test(t)) continue;
    return t.slice(0, 200);
  }
  return undefined;
}

// Parser.init はプロセスで1回だけ
let runtimeInit: Promise<void> | undefined;

export class CommentExtractor {
  private readonly wasmDir: string;
  private readonly languages = new Map<string, Promise<Language>>();

  /** @param wasmDir tree-sitter.wasm と tree-sitter-<文法>.wasm があるディレクトリ */
  constructor(wasmDir: string) {
    this.wasmDir = wasmDir;
  }

  static supports(languageId: string): boolean {
    return languageId in GRAMMAR_BY_LANGUAGE_ID;
  }

  private loadLanguage(grammar: string): Promise<Language> {
    runtimeInit ??= TreeSitter.Parser.init({ locateFile: (file: string) => path.join(this.wasmDir, file) });
    let lang = this.languages.get(grammar);
    if (!lang) {
      lang = runtimeInit
        .then(() => readFile(path.join(this.wasmDir, `tree-sitter-${grammar}.wasm`)))
        .then((bytes) => TreeSitter.Language.load(new Uint8Array(bytes)));
      // 失敗した読み込みを使い回さない
      lang.catch(() => this.languages.delete(grammar));
      this.languages.set(grammar, lang);
    }
    return lang;
  }

  /**
   * @param source ファイル全体のテキスト
   * @param languageId VS Code の言語 ID
   * @param file 結果に記録するファイル名（context にファイル名を渡すのに使う）
   */
  async extract(source: string, languageId: string, file = ''): Promise<RawComment[]> {
    const grammar = GRAMMAR_BY_LANGUAGE_ID[languageId];
    if (!grammar) return [];
    const language = await this.loadLanguage(grammar);
    const parser: Parser = new TreeSitter.Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);
    if (!tree) {
      parser.delete();
      throw new Error(`failed to parse ${file || languageId}`);
    }
    const lines = source.split(/\r?\n/);
    const out: RawComment[] = [];

    try {
      const cursor = tree.walk();
      let done = false;
      while (!done) {
        const node = cursor.currentNode;
        let descend = true;

        if (isCommentNode(node)) {
          descend = false;
          const startLine = node.startPosition.row;
          const startColumn = node.startPosition.column;
          const before = (lines[startLine] ?? '').slice(0, startColumn).trim();
          const trailing = before !== '';
          out.push({
            file,
            languageId,
            kind: node.text.startsWith('/*') || node.text.startsWith('=begin') ? 'block' : 'line',
            startLine,
            endLine: node.endPosition.row,
            startColumn,
            endColumn: node.endPosition.column,
            trailing,
            text: node.text,
            codeLine: trailing ? before.slice(0, 200) : nextCodeLine(lines, node.endPosition.row),
          });
        } else if (grammar === 'python' && node.type === 'string') {
          descend = false;
          const owner = docstringOwner(node);
          if (owner) {
            out.push({
              file,
              languageId,
              kind: 'docstring',
              startLine: node.startPosition.row,
              endLine: node.endPosition.row,
              startColumn: node.startPosition.column,
              endColumn: node.endPosition.column,
              trailing: false,
              text: node.text,
              codeLine: owner === 'module' ? undefined : lines[owner.startPosition.row]?.trim().slice(0, 200),
            });
          }
        }

        if (descend && cursor.gotoFirstChild()) continue;
        if (cursor.gotoNextSibling()) continue;
        for (;;) {
          if (!cursor.gotoParent()) {
            done = true;
            break;
          }
          if (cursor.gotoNextSibling()) break;
        }
      }
      cursor.delete();
    } finally {
      tree.delete();
      parser.delete();
    }
    return out;
  }
}
