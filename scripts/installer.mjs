// Windows 用のインストーラ(NSIS)を作る: release/MarshallEducater-Setup-<版>.exe
// 中身は配布用フォルダ(dist/MarshallEducater-win32-x64、scripts/dist.mjs で作る)をそのまま使う(electron-builder の prepackaged)。
// 使い方: node scripts/installer.mjs          … ビルド → 配布用フォルダ → インストーラ(npm run installer)
//         node scripts/installer.mjs --test   … さらに、tests/tmp の中へ無人で入れる → 起動 → 上書きインストール → アンインストール、を確かめる
//         node scripts/installer.mjs --no-build … 今ある配布用フォルダからインストーラだけ作る
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkExeIcon } from './exe-icon.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = pkg.productName;
const version = pkg.version;
const args = process.argv.slice(2);
const say = (s) => console.log(`installer: ${s}`);

if (process.platform !== 'win32') {
  console.error('installer: Windows でだけ作れます');
  process.exit(1);
}

/** electron-builder の設定(DECISIONS.md「インストーラ」)。 */
export const builderConfig = {
  appId: 'io.github.marshalleducater',
  productName: name,
  directories: { output: 'release' },
  win: { target: ['nsis'], icon: 'build/icon.ico' },
  nsis: {
    oneClick: false, // 入れる場所を選べる案内つきのインストーラ
    perMachine: false, // ユーザー単位(管理者の権限なし)
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: name,
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    deleteAppDataOnUninstall: false, // 設定(%APPDATA%)は消さない。学習データ(ドキュメント)にはもともと触れない
    runAfterFinish: true,
    artifactName: '${productName}-Setup-${version}.${ext}',
    uninstallDisplayName: '${productName} ${version}',
  },
  publish: null,
};

const node = process.execPath;
const run = (file, a) => {
  const r = spawnSync(node, [join(root, file), ...a], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

// インストーラの中身は release/app/ に作る(dist/ のアプリが起動中でも作れるように)
const appDir = join(root, 'release', 'app', `${name}-win32-x64`);
if (!args.includes('--no-build')) {
  say('ビルドと、インストーラに入れるアプリのフォルダ');
  run('scripts/build.mjs', []);
  run('scripts/dist.mjs', ['--out', 'release/app']);
}
if (!existsSync(join(appDir, `${name}.exe`))) {
  console.error(`installer: 配布用フォルダがありません: ${appDir}`);
  process.exit(1);
}

say('インストーラを作っています(electron-builder、NSIS)');
const { build, Platform } = await import('electron-builder');
await build({ targets: Platform.WINDOWS.createTarget(['nsis'], 'x64'), prepackaged: appDir, config: builderConfig, publish: 'never' });
const setup = join(root, 'release', `${name}-Setup-${version}.exe`);
if (!existsSync(setup)) {
  console.error(`installer: できていません: ${setup}`);
  process.exit(1);
}
say(await checkExeIcon(setup, join(root, 'build', 'icon.ico')).then((m) => `インストーラの${m}`, (e) => `注意: インストーラのアイコンを確かめられません(${e.message})`));
say(`OK -> ${setup}(${(statSync(setup).size / 1024 / 1024).toFixed(1)} MB、版 ${version})`);

if (args.includes('--test')) await installTest(setup);

// ───────── 無人で入れて確かめる ─────────

function shortcutPaths() {
  const desktop = join(homedir(), 'Desktop', `${name}.lnk`);
  const startMenu = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${name}.lnk`);
  return { desktop, startMenu };
}

function uninstallKeyExists() {
  // electron-builder はユーザー単位の入れ方で HKCU の Uninstall に appId の GUID のキーを作る。表示名で探す
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', `${name} `, '/d'], { encoding: 'utf8' });
    return /DisplayName/.test(out);
  } catch {
    return false;
  }
}

async function installTest(setupExe) {
  const sc = shortcutPaths();
  // 人がすでにこのアプリを入れているなら、そのインストールを壊さないよう、確認は行わない
  if (existsSync(sc.desktop) || existsSync(sc.startMenu) || uninstallKeyExists()) {
    say('この PC にはすでに MarshallEducater が入っているため、無人での入れる・消すの確認は飛ばします(人のインストールを壊さないため)');
    return;
  }
  mkdirSync(join(root, 'tests', 'tmp'), { recursive: true });
  const base = mkdtempSync(join(root, 'tests', 'tmp', 'install-'));
  const instDir = join(base, 'app');
  const env = { ...process.env, ME_DATA_DIR: join(base, 'data'), ME_USER_DATA: join(base, 'userData'), ME_HEADLESS: '1' };
  delete env.ME_FAKE_CLAUDE;
  const results = [];
  const check = (label, ok) => {
    results.push(`${ok ? 'OK ' : 'NG '} ${label}`);
    say(`${ok ? 'OK ' : 'NG '} ${label}`);
  };
  const install = () => spawnSync(setupExe, ['/S', `/D=${instDir}`], { stdio: 'inherit', windowsHide: true });

  // 1. 入れる(/S = 無人、/D = 入れる場所。/D は最後に、引用符なしで)
  let r = install();
  const exe = join(instDir, `${name}.exe`);
  check(`無人で入れられる(終了コード ${r.status})`, r.status === 0 && existsSync(exe));
  check('スタートメニューのショートカット', existsSync(sc.startMenu));
  check('デスクトップのショートカット', existsSync(sc.desktop));
  check('アンインストールの登録(HKCU)', uninstallKeyExists());

  // 2. 起動してウィンドウが出る・プロジェクトを作れる(データは tests/tmp)
  const { _electron: electron } = await import('@playwright/test');
  const launchAndCount = async (create) => {
    const app = await electron.launch({ executablePath: exe, args: [], env, timeout: 60000 });
    try {
      const page = await app.firstWindow();
      await page.getByTestId('app-title').waitFor({ timeout: 30000 });
      if (create) {
        await page.getByTestId('new-project').click();
        await page.getByTestId('f-university').fill('インストール確認大学');
        await page.getByTestId('f-faculty').fill('理学部');
        await page.getByTestId('f-examDate').fill('2030-02-25');
        await page.getByTestId('subject-数学II・B・C').check();
        await page.getByTestId('save-project').click();
        await page.getByTestId('screen-dashboard').waitFor({ timeout: 30000 });
        await page.getByTestId('nav-home').click();
      }
      // ホームの一覧が読み込まれるのを待ってから数える
      await page.getByTestId('project-card').first().waitFor({ timeout: 15000 }).catch(() => undefined);
      return await page.getByTestId('project-card').count();
    } finally {
      await app.close();
    }
  };
  check('入れたアプリが起動し、プロジェクトを作れる', (await launchAndCount(true)) === 1);

  // 3. 上書きインストール(同じ版を入れ直す)→ データ・設定が残る
  r = install();
  check(`上書きインストール(終了コード ${r.status})`, r.status === 0 && existsSync(exe));
  check('上書きしてもプロジェクト(データ)が残る', (await launchAndCount(false)) === 1);

  // 4. アンインストール(/S)。学習データは消えない、ショートカット・登録・アプリの中身は消える
  const uninstaller = readdirSync(instDir).find((f) => /^Uninstall .*\.exe$/i.test(f));
  check('アンインストーラがある', !!uninstaller);
  if (uninstaller) {
    // アンインストーラは自分を一時フォルダへ写して動くので、少し待って終わりを確かめる
    spawnSync(join(instDir, uninstaller), ['/S'], { stdio: 'inherit', windowsHide: true });
    for (let i = 0; i < 60 && existsSync(exe); i++) await new Promise((res) => setTimeout(res, 500));
  }
  check('アプリの実行ファイルが消える', !existsSync(exe));
  check('スタートメニューのショートカットが消える', !existsSync(sc.startMenu));
  check('デスクトップのショートカットが消える', !existsSync(sc.desktop));
  check('アンインストールの登録が消える', !uninstallKeyExists());
  check('学習データ(データフォルダ)は残る', existsSync(join(base, 'data', 'インストール確認大学 理学部', 'project.json')));
  const ng = results.filter((x) => x.startsWith('NG'));
  say(ng.length ? `無人での確認: NG ${ng.length} 件` : '無人での確認: すべて OK');
  if (ng.length) process.exitCode = 1;
}
