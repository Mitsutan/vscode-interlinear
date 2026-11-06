/**
 * Node から直接使う場合（単体テストなど）の WASM ディレクトリ。
 * 拡張機能では dist/wasm を使うので、このファイルはバンドルに含めない（import.meta を使うため）。
 */
import { createRequire } from 'node:module';
import path from 'node:path';

export function nodeWasmDir(): string {
  const require = createRequire(import.meta.url);
  return path.dirname(require.resolve('@vscode/tree-sitter-wasm'));
}
