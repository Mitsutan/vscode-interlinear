/**
 * src/managed/manifest.ts の URL が今もダウンロードでき、サイズが一致するかを確かめる（中身はダウンロードしない）。
 * llama.cpp やモデルを更新したときに実行する: npm run check:manifest
 */
import { LLAMA_ASSETS, MODELS } from '../src/managed/manifest.ts';

const assets = [...Object.entries(LLAMA_ASSETS), ...Object.entries(MODELS)];
let failed = 0;
for (const [key, a] of assets) {
  try {
    const res = await fetch(a.url, { method: 'HEAD', redirect: 'follow' });
    // Hugging Face は転送前の応答にだけ x-linked-size を付けることがあるので、どちらかが一致すればよい
    const size = Number(res.headers.get('content-length') ?? res.headers.get('x-linked-size'));
    const ok = res.ok && size === a.bytes;
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${key.padEnd(12)} HTTP ${res.status} ${size} bytes（期待値 ${a.bytes}）${a.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${key.padEnd(12)} ${e instanceof Error ? e.message : String(e)}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
