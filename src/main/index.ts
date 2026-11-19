import { app, BrowserWindow, ipcMain, nativeImage, net, protocol, shell } from 'electron';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppCore } from '../core/app';
import { createApi } from '../core/api';
import { KATEX_CSS_PLACEHOLDER } from '../core/print';

// テスト時は利用者の設定・データに触れないよう、保存先を環境変数で差し替える。
if (process.env.ME_USER_DATA) app.setPath('userData', process.env.ME_USER_DATA);
// 偽 Claude の場所(アプリのフォルダからの相対)。
if (process.env.ME_FAKE_CLAUDE === '1' && !process.env.ME_FAKE_CLAUDE_PATH) {
  process.env.ME_FAKE_CLAUDE_PATH = join(app.getAppPath(), 'Tools', 'fake-claude', 'fake-claude.mjs');
}

const headless = process.env.ME_HEADLESS === '1';
if (headless) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let mainWindow: BrowserWindow | null = null;

/** アプリのアイコン(Windows は .ico、ほかは .png)。見つからなければ undefined(Electron の既定)。 */
export function appIcon(): Electron.NativeImage | undefined {
  const file = join(__dirname, '..', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  const img = nativeImage.createFromPath(file);
  return img.isEmpty() ? undefined : img;
}

// タスクバーでアプリを見分ける ID(Windows)。アイコンとまとまりがこの ID に付く
if (process.platform === 'win32') app.setAppUserModelId('MarshallEducater');

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    title: 'MarshallEducater',
    // ウィンドウの左上とタスクバーのアイコン(build/icon.* をビルド時に out/ へ写したもの)
    icon: appIcon(),
    show: !headless,
    // 自動操作テストでは、画面の外に置いて人の作業を邪魔しない。
    // (完全に隠すと描画が止まり、Playwright の操作が1回ごとに数秒かかる)
    ...(headless ? { x: -20000, y: -20000, skipTaskbar: true, focusable: false } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: !headless,
    },
  });
  if (headless) mainWindow.showInactive();
  mainWindow.setMenuBarVisibility(false);
  void mainWindow.loadURL('app://renderer/index.html');
  // 画面の中のリンクなどで、アプリの外のページへ移動させない
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://renderer/')) e.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function broadcast(event: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('me:event', event);
  }
}

// 画面のファイルは app://renderer/… で配る(file:// だと worker や fetch に制約があるため)。
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

function registerAppProtocol(): void {
  const rendererDir = normalize(join(__dirname, '../renderer'));
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const file = normalize(join(rendererDir, decodeURIComponent(url.pathname)));
    if (url.host !== 'renderer' || (file !== rendererDir && !file.startsWith(rendererDir + sep))) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

/** 印刷用の HTML を、見えないウィンドウで開いて PDF にする。 */
async function printPdf(html: string, outPdf: string): Promise<void> {
  const cssHref = pathToFileURL(join(__dirname, '../katex/katex.min.css')).toString();
  const tmp = join(app.getPath('temp'), `me-print-${process.pid}-${Date.now()}.html`);
  writeFileSync(tmp, html.replace(KATEX_CSS_PLACEHOLDER, cssHref), 'utf8');
  const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  try {
    await win.loadFile(tmp);
    // 数式のフォントが読み込まれるのを待ってから印刷する
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true });
    mkdirSync(dirname(outPdf), { recursive: true });
    writeFileSync(outPdf, pdf);
  } finally {
    win.destroy();
    rmSync(tmp, { force: true });
  }
}

void app.whenReady().then(() => {
  registerAppProtocol();
  const core = new AppCore({
    userDataDir: app.getPath('userData'),
    defaultDataDir: join(app.getPath('documents'), 'MarshallEducaterData'),
    envDataDir: process.env.ME_DATA_DIR || undefined,
    cropImage: (srcPng, bbox, outPng) => {
      const img = nativeImage.createFromPath(srcPng);
      const { width, height } = img.getSize();
      if (!width || !height) throw new Error('ページ画像を開けません');
      const x = Math.min(width - 1, Math.max(0, Math.round(bbox.x * width)));
      const y = Math.min(height - 1, Math.max(0, Math.round(bbox.y * height)));
      const w = Math.max(1, Math.min(width - x, Math.round(bbox.w * width)));
      const h = Math.max(1, Math.min(height - y, Math.round(bbox.h * height)));
      mkdirSync(dirname(outPng), { recursive: true });
      writeFileSync(outPng, img.crop({ x, y, width: w, height: h }).toPNG());
    },
    printPdf,
    revealFile: (path) => {
      if (!headless) shell.showItemInFolder(path);
    },
  });
  const api = createApi(core) as Record<string, (...args: unknown[]) => unknown>;

  // 画面からの呼び出しの窓口は1つだけ。api に無い名前は断る。
  ipcMain.handle('me:call', async (_e, method: string, args: unknown[]) => {
    try {
      if (!Object.prototype.hasOwnProperty.call(api, method)) throw new Error(`知らない操作です: ${method}`);
      const value = await api[method](...(Array.isArray(args) ? args : []));
      return { ok: true, value };
    } catch (e) {
      const err = e as Error & { kind?: string };
      return { ok: false, error: { message: err.message ?? String(e), kind: err.kind ?? null } };
    }
  });

  core.jobs.on('change', (job) => broadcast({ type: 'job', job }));
  core.jobs.on('cleared', () => broadcast({ type: 'jobs-cleared' }));

  // 教材の「まとめて作る」で翌日以降に回した章の続きを、起動時と 10 分ごとに並べる(その日の上限のぶんだけ)
  const resumeDeferred = () => {
    try {
      api.resumeDeferredChapters();
    } catch {
      /* データの場所が読めないときなどは、次の機会に */
    }
  };
  setTimeout(resumeDeferred, 5000);
  setInterval(resumeDeferred, 10 * 60 * 1000);

  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
