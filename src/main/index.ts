import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';

// テスト時は利用者の設定・データに触れないよう、保存先を環境変数で差し替える。
if (process.env.ME_USER_DATA) app.setPath('userData', process.env.ME_USER_DATA);

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'MarshallEducater',
    show: process.env.ME_HEADLESS !== '1',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('me:ping', () => ({ app: 'MarshallEducater', version: app.getVersion() }));

void app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
