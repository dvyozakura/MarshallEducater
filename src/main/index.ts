import { app, BrowserWindow, ipcMain, net, protocol } from 'electron';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppCore } from '../core/app';
import { createApi } from '../core/api';

// テスト時は利用者の設定・データに触れないよう、保存先を環境変数で差し替える。
if (process.env.ME_USER_DATA) app.setPath('userData', process.env.ME_USER_DATA);
// 偽 Claude の場所(アプリのフォルダからの相対)。
if (process.env.ME_FAKE_CLAUDE === '1' && !process.env.ME_FAKE_CLAUDE_PATH) {
  process.env.ME_FAKE_CLAUDE_PATH = join(app.getAppPath(), 'Tools', 'fake-claude', 'fake-claude.mjs');
}

const headless = process.env.ME_HEADLESS === '1';
if (headless) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    title: 'MarshallEducater',
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

void app.whenReady().then(() => {
  registerAppProtocol();
  const core = new AppCore({
    userDataDir: app.getPath('userData'),
    defaultDataDir: join(app.getPath('documents'), 'MarshallEducaterData'),
    envDataDir: process.env.ME_DATA_DIR || undefined,
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

  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
