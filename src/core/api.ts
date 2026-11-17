// 画面(renderer)から使える機能の一覧。ここに無いことは画面からはできない。
// Electron に依存しないので、単体テストからも同じ入口で呼べる。
import { todayString } from '../shared/dates';
import type { JobInfo } from '../shared/jobs';
import { PingOutputSchema, type AppSettings, type ProjectInput } from '../shared/schema';
import { SUBJECT_PRESETS } from '../shared/subjects';
import type { AppCore } from './app';
import { callClaude } from './claude/task';
import { ensureDir } from './fsutil';
import { createProject, getProject, listProjects, updateProject } from './projects';

export function createApi(core: AppCore) {
  return {
    // ───── アプリ全体 ─────
    appInfo: () => ({
      name: 'MarshallEducater',
      today: todayString(),
      dataDir: core.dataDir(),
      defaultDataDir: core.defaultDataDir(),
      dataDirLocked: core.dataDirLocked(),
      fakeClaude: process.env.ME_FAKE_CLAUDE === '1',
      settingsProblem: core.settingsProblem,
    }),
    getSettings: (): AppSettings => core.getSettings(),
    updateSettings: (patch: Partial<AppSettings>): AppSettings => core.updateSettings(patch),
    usage: () => ({ used: core.limiter.used(), limit: core.limiter.limit() }),

    // ───── ジョブ ─────
    listJobs: (): JobInfo[] => core.jobs.list(),
    cancelJob: (id: string): boolean => core.jobs.cancel(id),
    clearFinishedJobs: (): void => core.jobs.clearFinished(),
    /** Claude を呼べるかの確認(設定画面の「接続の確認」)。 */
    startPing: (): JobInfo => {
      const dir = core.dataDir();
      ensureDir(dir);
      return core.jobs.add({
        kind: 'ping',
        title: 'Claude との接続の確認',
        params: {},
        run: async (ctx) => {
          ctx.progress('Claude の返事を待っています');
          const r = await callClaude({ projectDir: dir, kind: 'ping', vars: { note: '' }, schema: PingOutputSchema, env: core.claudeEnv(), signal: ctx.signal });
          return r.data;
        },
      });
    },

    // ───── プロジェクト ─────
    subjectPresets: () => SUBJECT_PRESETS.map((p) => ({ name: p.name, group: p.group })),
    listProjects: () => listProjects(core),
    getProject: (projectId: string) => getProject(core, projectId),
    createProject: (input: ProjectInput) => createProject(core, input),
    updateProject: (projectId: string, input: ProjectInput) => updateProject(core, projectId, input),
  };
}

export type Api = ReturnType<typeof createApi>;
export type ApiMethod = keyof Api;
