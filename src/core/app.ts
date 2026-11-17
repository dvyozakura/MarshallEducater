import { join } from 'node:path';
import { FORMAT_VERSION, AppSettingsSchema, type AppSettings } from '../shared/schema';
import { DailyLimiter } from './claude/limiter';
import type { ClaudeSettings } from './claude/runner';
import type { ClaudeEnv } from './claude/task';
import { ensureDir } from './fsutil';
import { JobQueue } from './jobs';
import { ProjectPaths } from './paths';
import { cleanupTmpFiles, Files, readData, writeData } from './store';

export interface CoreOptions {
  /** アプリの設定を置く場所(Electron の userData)。 */
  userDataDir: string;
  /** データの既定の場所(ドキュメント/MarshallEducaterData)。 */
  defaultDataDir: string;
  /** 環境変数 ME_DATA_DIR による差し替え(テスト用。設定より優先)。 */
  envDataDir?: string;
  /** 子プロセスに足す環境変数(単体テストで偽 Claude を指定する)。 */
  extraEnv?: Record<string, string>;
  /** 画像の一部を切り出して PNG で保存する(Electron の機能で行うので、外から渡す)。 */
  cropImage?: CropImage;
}

/** bbox はページの左上を (0,0)、右下を (1,1) とした割合。 */
export type CropImage = (srcPng: string, bbox: { x: number; y: number; w: number; h: number }, outPng: string) => void;

/** アプリの中心。設定・データの場所・ジョブの列・1日の上限をまとめて持つ。Electron には依存しない。 */
export class AppCore {
  private settings: AppSettings;
  readonly jobs: JobQueue;
  /** 設定ファイルが壊れていて既定値で起動した場合の説明。 */
  settingsProblem: string | null = null;

  constructor(private readonly opts: CoreOptions) {
    ensureDir(opts.userDataDir);
    this.settings = this.loadSettings();
    this.jobs = new JobQueue(() => this.settings.concurrency);
    try {
      ensureDir(this.dataDir());
      cleanupTmpFiles(this.dataDir());
    } catch {
      /* データの場所が作れない場合は、使うときにエラーを出す */
    }
  }

  private get settingsFile(): string {
    return join(this.opts.userDataDir, 'settings.json');
  }

  private loadSettings(): AppSettings {
    const defaults = AppSettingsSchema.parse({ version: FORMAT_VERSION });
    try {
      return readData(this.settingsFile, Files.settings);
    } catch (e) {
      if ((e as { kind?: string }).kind !== 'missing') this.settingsProblem = (e as Error).message;
      return defaults;
    }
  }

  get cropImage(): CropImage | undefined {
    return this.opts.cropImage;
  }

  getSettings(): AppSettings {
    return { ...this.settings };
  }

  /** いま有効なデータの場所。 */
  dataDir(): string {
    return this.opts.envDataDir || this.settings.dataDir || this.opts.defaultDataDir;
  }

  defaultDataDir(): string {
    return this.opts.defaultDataDir;
  }

  /** データの場所が環境変数で固定されているか(テスト時)。 */
  dataDirLocked(): boolean {
    return !!this.opts.envDataDir;
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const next = AppSettingsSchema.parse({ ...this.settings, ...patch, version: FORMAT_VERSION });
    this.settings = writeData(this.settingsFile, Files.settings, next);
    this.settingsProblem = null;
    ensureDir(this.dataDir());
    this.jobs.pump();
    return this.getSettings();
  }

  claudeSettings(): ClaudeSettings {
    return {
      claudePath: this.settings.claudePath,
      model: this.settings.model,
      timeoutMs: this.settings.timeoutMin * 60 * 1000,
      extraEnv: this.opts.extraEnv,
    };
  }

  /** 1日の上限の数え役。データの場所が設定で変わっても追えるよう、毎回いまの場所で作る。 */
  get limiter(): DailyLimiter {
    return new DailyLimiter(join(this.dataDir(), 'usage.json'), () => this.settings.dailyLimit);
  }

  claudeEnv(): ClaudeEnv {
    return { settings: this.claudeSettings(), limiter: this.limiter };
  }

  projectDir(projectId: string): string {
    if (!projectId || /[\\/]|^\.+$/.test(projectId)) throw new Error('プロジェクトの指定が正しくありません');
    return join(this.dataDir(), projectId);
  }

  paths(projectId: string): ProjectPaths {
    return new ProjectPaths(this.projectDir(projectId));
  }
}
