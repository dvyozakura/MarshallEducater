import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const repoRoot = resolve(__dirname, '../..');
export const tmpRoot = join(repoRoot, 'tests', 'tmp');

export interface Launched {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
  userData: string;
  controlFile: string;
  /** 同じデータのまま起動し直す */
  relaunch: () => Promise<Launched>;
  /** 偽 Claude の振る舞いを切り替える */
  setFake: (control: unknown) => void;
}

/** 偽 Claude・専用のデータフォルダで Electron を起動する。本番データには触れない。 */
export async function launchApp(opts: { dir?: string; env?: Record<string, string> } = {}): Promise<Launched> {
  mkdirSync(tmpRoot, { recursive: true });
  const base = opts.dir ?? mkdtempSync(join(tmpRoot, 'e2e-'));
  const dataDir = join(base, 'data');
  const userData = join(base, 'userData');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(userData, { recursive: true });
  const controlFile = join(base, 'fake-control.json');
  const app = await electron.launch({
    args: [repoRoot],
    cwd: repoRoot,
    env: {
      ...(process.env as Record<string, string>),
      ME_FAKE_CLAUDE: '1',
      ME_FAKE_CONTROL: controlFile,
      ME_DATA_DIR: dataDir,
      ME_USER_DATA: userData,
      ME_HEADLESS: '1',
      ...(opts.env ?? {}),
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const launched: Launched = {
    app,
    page,
    dataDir,
    userData,
    controlFile,
    relaunch: async () => {
      await app.close();
      return launchApp({ dir: base, env: opts.env });
    },
    setFake: (control) => writeFileSync(controlFile, JSON.stringify(control), 'utf8'),
  };
  return launched;
}
