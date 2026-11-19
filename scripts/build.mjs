// 開発ビルド: main / preload を esbuild で、renderer を vite でまとめて out/ に出す。
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'out');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'warning',
};

await build({ ...common, entryPoints: [resolve(root, 'src/main/index.ts')], outfile: resolve(out, 'main/index.js') });
await build({ ...common, entryPoints: [resolve(root, 'src/preload/index.ts')], outfile: resolve(out, 'preload/index.js') });

await viteBuild({ configFile: resolve(root, 'vite.config.mts'), logLevel: 'warn' });

// プロンプト(ファイルとして置く)と、印刷用 HTML が使う KaTeX の CSS・フォント
cpSync(resolve(root, 'src/prompts'), resolve(out, 'prompts'), { recursive: true });
mkdirSync(resolve(out, 'katex'), { recursive: true });
cpSync(resolve(root, 'node_modules/katex/dist/katex.min.css'), resolve(out, 'katex/katex.min.css'));
cpSync(resolve(root, 'node_modules/katex/dist/fonts'), resolve(out, 'katex/fonts'), { recursive: true });

// pdf.js が PDF を描くときに読むデータ(日本語の文字コード表・標準フォント・画像の復号)
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  cpSync(resolve(root, 'node_modules/pdfjs-dist', dir), resolve(out, 'renderer/pdfjs', dir), { recursive: true });
}

// アプリのアイコン(人が用意したもの。作り直さない)。ウィンドウの左上・タスクバー用(開発時の起動でも出す)
cpSync(resolve(root, 'build/icon.ico'), resolve(out, 'icon.ico'));
cpSync(resolve(root, 'build/icon.png'), resolve(out, 'icon.png'));

console.log('build: OK -> out/');
