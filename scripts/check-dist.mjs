// 配布用フォルダのアプリを実際に起動して、画面が出ること・プロジェクトを作れることを確かめる(偽 Claude も本物も呼ばない)。
// データと設定は tests/tmp/ の下に置く(本番のデータには触れない)。
import { _electron as electron } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).productName;
const exe = resolve(root, 'dist', `${name}-${process.platform}-${process.arch}`, process.platform === 'win32' ? `${name}.exe` : name);
if (!existsSync(exe)) {
  console.error(`check-dist: 実行ファイルがありません: ${exe}`);
  process.exit(1);
}
/**
 * exe に埋め込まれたアイコンを読み、.ico の画像(大きさごと)と同じかを調べる。
 * 読むのには resedit(@electron/packager がアイコンを書き込むのに使うライブラリ。新しい依存ではない)を使う。
 */
export async function checkExeIcon(exePath, icoPath) {
  const ResEdit = await import('resedit');
  const pe = ResEdit.NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(pe);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (groups.length === 0) throw new Error('exe にアイコンがありません');
  const ico = ResEdit.Data.IconFile.from(readFileSync(icoPath));
  const want = ico.icons.map((i) => Buffer.from(i.data.generate ? i.data.generate() : i.data.bin ?? new Uint8Array()).toString('base64'));
  const got = groups[0].getIconItemsFromEntries(res.entries).map((i) => Buffer.from(i.generate ? i.generate() : i.bin ?? new Uint8Array()).toString('base64'));
  const sizes = ico.icons.map((i) => `${i.width || 256}px`).join('・');
  if (got.length !== want.length || !want.every((w) => got.includes(w))) throw new Error(`exe のアイコンが build/icon.ico と違います(exe ${got.length} 枚、ico ${want.length} 枚)`);
  return `exe のアイコンは build/icon.ico と同じ(${want.length} 枚: ${sizes})`;
}

mkdirSync(resolve(root, 'tests/tmp'), { recursive: true });
const base = mkdtempSync(join(root, 'tests', 'tmp', 'dist-'));
const env = { ...process.env, ME_DATA_DIR: join(base, 'data'), ME_USER_DATA: join(base, 'userData'), ME_HEADLESS: '1' };
delete env.ME_FAKE_CLAUDE;

const app = await electron.launch({ executablePath: exe, args: [], env, timeout: 60000 });
let ok = false;
try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const title = await page.getByTestId('app-title').textContent({ timeout: 30000 });
  if (title?.trim() !== 'MarshallEducater') throw new Error(`画面の見出しが違います: ${title}`);
  // プロジェクトを1つ作れる(ファイルの読み書き・preload の窓口・画面の移動が動いている)
  await page.getByTestId('new-project').click();
  await page.getByTestId('f-university').fill('配布確認大学');
  await page.getByTestId('f-faculty').fill('理学部');
  await page.getByTestId('f-examDate').fill('2030-02-25');
  await page.getByTestId('subject-数学II・B・C').check();
  await page.getByTestId('save-project').click();
  await page.getByTestId('screen-dashboard').waitFor({ timeout: 30000 });
  if (!existsSync(join(base, 'data', '配布確認大学 理学部', 'project.json'))) throw new Error('project.json が作られていません');
  // 数式(KaTeX)とプロンプトのファイルが配布物に入っている
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('math-preview').locator('.katex').first().waitFor({ timeout: 30000 });
  if (!existsSync(resolve(dirname(exe), 'resources/app/out/prompts/_common.md'))) throw new Error('配布物にプロンプトのファイルがありません');
  // アイコン: exe の中のアイコン(リソース)が、build/icon.ico の画像とすべて同じ
  if (process.platform === 'win32') console.log(`check-dist: ${await checkExeIcon(exe, resolve(root, 'build/icon.ico'))}`);
  if (!existsSync(resolve(dirname(exe), 'resources/app/out/icon.ico'))) throw new Error('配布物にウィンドウ用のアイコン(out/icon.ico)がありません');
  ok = true;
} catch (e) {
  console.error(`check-dist: 失敗 — ${e.message}`);
} finally {
  await app.close();
}
console.log(ok ? `check-dist: OK(${exe} が起動し、プロジェクトを作れました)` : 'check-dist: NG');
process.exit(ok ? 0 : 1);
