// 配布物に入る本番用の依存(package.json の dependencies とその依存)と Electron の、ライセンスの一覧を作る。
// できるもの: THIRD_PARTY_NOTICES.md(名前・版・ライセンス・配布元と、ライセンスの本文)
// 使い方: node scripts/third-party-notices.mjs(npm run notices)
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function readPkg(name) {
  const dir = join(root, 'node_modules', name);
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return null;
  return { dir, json: JSON.parse(readFileSync(file, 'utf8')) };
}

function licenseText(dir) {
  const f = readdirSync(dir).find((n) => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(n));
  return f ? readFileSync(join(dir, f), 'utf8').trim() : null;
}

function repoUrl(json) {
  const r = json.repository;
  const url = typeof r === 'string' ? r : r?.url;
  return (url ?? json.homepage ?? '').replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://');
}

// dependencies を順にたどる(devDependencies は配布物に入らないので含めない)
const seen = new Map();
const queue = Object.keys(pkg.dependencies ?? {});
while (queue.length) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  const p = readPkg(name);
  if (!p) continue;
  seen.set(name, p);
  for (const d of Object.keys(p.json.dependencies ?? {})) queue.push(d);
}
// Electron 本体(配布物の実行ファイル。Chromium などのライセンスは配布フォルダの LICENSES.chromium.html にある)
const electron = readPkg('electron');
if (electron) seen.set('electron', electron);

const rows = [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
const out = [
  '# THIRD_PARTY_NOTICES',
  '',
  `MarshallEducater の配布物に含まれる、ほかの人が作ったソフトウェアとそのライセンスの一覧です(\`node scripts/third-party-notices.mjs\` で作成。${rows.length} 件)。`,
  '',
  'Electron に含まれる Chromium・Node.js などのライセンスは、配布フォルダ(インストール先)の `LICENSES.chromium.html` と `LICENSE` にあります。',
  '',
  '| 名前 | 版 | ライセンス | 配布元 |',
  '|---|---|---|---|',
  ...rows.map(([name, p]) => `| ${name} | ${p.json.version} | ${typeof p.json.license === 'string' ? p.json.license : (p.json.license?.type ?? '不明')} | ${repoUrl(p.json)} |`),
  '',
  '---',
  '',
];
for (const [name, p] of rows) {
  out.push(`## ${name} ${p.json.version}`, '', `ライセンス: ${typeof p.json.license === 'string' ? p.json.license : (p.json.license?.type ?? '不明')}`, '');
  const text = licenseText(p.dir);
  out.push(text ? ['```', text, '```'].join('\n') : '(パッケージにライセンスの本文のファイルがありません。上の配布元を参照してください)', '');
}
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), out.join('\n'), 'utf8');
console.log(`third-party-notices: ${rows.length} 件 -> THIRD_PARTY_NOTICES.md`);
for (const [name, p] of rows) console.log(`  ${name}@${p.json.version} ${typeof p.json.license === 'string' ? p.json.license : p.json.license?.type}`);
