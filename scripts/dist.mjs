// 配布用のビルド(インストーラ無しのフォルダ形式): dist/MarshallEducater-win32-x64/MarshallEducater.exe
// main・preload・renderer はビルド時に1つにまとめてあるので、配布物に node_modules は要らない。out/ と最小の package.json だけを入れる。
// Electron 本体は、まず @electron/packager で用意する(本体を取得できないときは、node_modules/electron/dist を写して作る)。
import { packager } from '@electron/packager';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const electronVersion = JSON.parse(readFileSync(resolve(root, 'node_modules/electron/package.json'), 'utf8')).version;
// --out <フォルダ>: 作る場所を変える(インストーラ用。dist/ のアプリが起動中で消せないときも作れるように)
const outIdx = process.argv.indexOf('--out');
const dist = outIdx >= 0 && process.argv[outIdx + 1] ? resolve(root, process.argv[outIdx + 1]) : resolve(root, 'dist');
const staging = resolve(dist, 'app-staging');
const name = pkg.productName; // アプリ名「MarshallEducater」(綴りはこのまま)
const target = resolve(dist, `${name}-${process.platform}-${process.arch}`);

if (!existsSync(resolve(root, 'out/main/index.js'))) {
  console.error('dist: out/ がありません。先に node scripts/build.mjs を実行してください。');
  process.exit(1);
}

// 1. アプリの中身(out/ と package.json)をそろえる
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(resolve(root, 'out'), resolve(staging, 'out'), { recursive: true, filter: (src) => !src.endsWith('.map') });
writeFileSync(resolve(staging, 'package.json'), JSON.stringify({ name: pkg.name, productName: name, version: pkg.version, description: pkg.description, author: pkg.author ?? name, main: pkg.main, private: true }, null, 2));

// 2. Electron 本体と合わせる
rmSync(target, { recursive: true, force: true });
let how = '@electron/packager';
try {
  // icon: exe に埋め込むアイコン(人が用意した build/icon.ico。作り直さない)
  await packager({ dir: staging, out: dist, name, platform: process.platform, arch: process.arch, electronVersion, overwrite: true, prune: false, asar: false, quiet: true, appVersion: pkg.version, icon: resolve(root, 'build/icon.ico') });
} catch (e) {
  console.warn(`dist: @electron/packager で作れませんでした(${e.message})。node_modules の Electron を写して作ります。`);
  how = 'node_modules/electron/dist の写し';
  rmSync(target, { recursive: true, force: true });
  cpSync(resolve(root, 'node_modules/electron/dist'), target, { recursive: true });
  const exe = process.platform === 'win32' ? 'electron.exe' : 'electron';
  if (existsSync(resolve(target, exe))) renameSync(resolve(target, exe), resolve(target, process.platform === 'win32' ? `${name}.exe` : name));
  rmSync(resolve(target, 'resources/default_app.asar'), { force: true });
  cpSync(staging, resolve(target, 'resources/app'), { recursive: true });
}
rmSync(staging, { recursive: true, force: true });

const exePath = resolve(target, process.platform === 'win32' ? `${name}.exe` : name);
if (!existsSync(exePath)) {
  console.error(`dist: 実行ファイルができていません: ${exePath}`);
  process.exit(1);
}
console.log(`dist: OK -> ${exePath}(Electron ${electronVersion}、${how})`);
