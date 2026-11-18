// scripts/smoke-main.ts を esbuild で1つにまとめて実行する(アプリ本体と同じコードで、Electron なしに動かす)。
// 使い方: node scripts/smoke-real.mjs [--fake]
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'tests', 'tmp', 'smoke-build');
mkdirSync(outDir, { recursive: true });
const outfile = resolve(outDir, 'smoke-main.cjs');
await build({ entryPoints: [resolve(root, 'scripts/smoke-main.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning' });
const r = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
