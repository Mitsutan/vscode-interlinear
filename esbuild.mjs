// 拡張機能を dist/extension.cjs に1ファイルでバンドルし、tree-sitter の WASM を dist/wasm/ にコピーする。
//   node esbuild.mjs            本体をビルド
//   node esbuild.mjs --watch    変更を監視してビルド
//   node esbuild.mjs --tests    本体 + 統合テストのスイート（dist-test/suite.cjs）をビルド
//   node esbuild.mjs --production  配布用（縮小し、ソースマップを付けない）
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');
const production = process.argv.includes('--production');

// 拡張が扱う言語の文法（src/core/extract.ts の GRAMMAR_BY_LANGUAGE_ID と揃える）
const GRAMMARS = ['typescript', 'tsx', 'javascript', 'python', 'go', 'rust', 'java', 'c-sharp', 'cpp', 'ruby', 'php', 'bash', 'css', 'powershell'];

async function copyWasm() {
  const src = path.dirname(require.resolve('@vscode/tree-sitter-wasm'));
  const dest = path.resolve('dist/wasm');
  await mkdir(dest, { recursive: true });
  for (const name of ['tree-sitter', ...GRAMMARS.map((g) => `tree-sitter-${g}`)]) {
    await copyFile(path.join(src, `${name}.wasm`), path.join(dest, `${name}.wasm`));
  }
}

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const builds = [{ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs' }];
if (tests) builds.push({ ...common, entryPoints: ['test/integration/suite.ts'], outfile: 'dist-test/suite.cjs' });

await copyWasm();
if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
