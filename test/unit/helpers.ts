import { CommentExtractor, languageIdForFile } from '../../src/core/extract.ts';
import { nodeWasmDir } from '../../src/core/node-wasm.ts';

const extractor = new CommentExtractor(nodeWasmDir());

/** 拡張子から言語を決めてコメントを抽出する */
export function extractComments(file: string, source: string) {
  const languageId = languageIdForFile(file);
  if (!languageId) throw new Error(`unsupported file: ${file}`);
  return extractor.extract(source, languageId, file);
}
