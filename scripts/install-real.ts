/**
 * 自動管理と同じ方法（manifest の URL と SHA-256 で検証）で llama.cpp とモデルをダウンロードし、
 * 実物を使うテスト用の環境変数を KEY=VALUE の形で標準出力に出す。
 *
 *   node scripts/install-real.ts <保存先> [0.8b|2b|8b] >> "$GITHUB_ENV"
 *
 * テストの偽の llama-server では、各 OS 向けに配布されている実物が展開・起動できるかまでは分からないので、
 * CI ではこれで用意した実物を使って確かめる。
 */
import path from 'node:path';
import { Installer } from '../src/managed/installer.ts';
import { MODEL_SIZES, type ModelSize } from '../src/managed/manifest.ts';

const [dir, size = '0.8b'] = process.argv.slice(2);
if (!dir || !MODEL_SIZES.includes(size as ModelSize)) {
  console.error('使い方: node scripts/install-real.ts <保存先> [0.8b|2b|8b]');
  process.exit(2);
}

const installer = new Installer(path.resolve(dir));
const server = await installer.installLlama();
console.error(`llama-server: ${server}`);
const model = await installer.installModel(size as ModelSize);
console.error(`model: ${model}`);
console.log(`INTERLINEAR_REAL_LLAMA_SERVER=${server}`);
console.log(`INTERLINEAR_REAL_MODEL=${model}`);
