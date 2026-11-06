/**
 * 配布用の VSIX を作る（npm run package。本体のビルドは esbuild.mjs が先に行う）。
 *
 * マイナー版が奇数ならプレリリースとして作る（例: 0.1.x はプレリリース、0.2.x は正式版）。
 * 1.0.0-beta.1 のような接尾辞で区別しないのは、Marketplace が major.minor.patch の版しか受け付けないため。
 * プレリリースかどうかは VSIX に書き込まれ、公開するときはそれに従う。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const preRelease = Number(version.split('.')[1]) % 2 === 1;
console.log(`${version}: ${preRelease ? 'プレリリース' : '正式版'}`);

// npx を使わないのは、Windows では npx.cmd になり、シェルを介さないと起動できないため
const vsce = createRequire(import.meta.url).resolve('@vscode/vsce/vsce');
execFileSync(process.execPath, [vsce, 'package', '--no-dependencies', ...(preRelease ? ['--pre-release'] : [])], { stdio: 'inherit' });
