// 画面(renderer)から使える機能の一覧。ここに無いことは画面からはできない。
// Electron に依存しないので、単体テストからも同じ入口で呼べる。
import { todayString } from '../shared/dates';
import type { JobInfo } from '../shared/jobs';
import { PingOutputSchema, type AppSettings, type ProjectInput, type UnitNode } from '../shared/schema';
import { SUBJECT_PRESETS } from '../shared/subjects';
import type { AppCore } from './app';
import { callClaude } from './claude/task';
import { ensureDir } from './fsutil';
import type { JobContext } from './jobs';
import { createProject, getProject, getSubject, listProjects, updateProject } from './projects';
import { getExtracted, readSource } from './reading';
import { deleteSource, getSource, importBegin, importFinish, importOriginal, importPage, listSources, readPageImage, type ImportBegin } from './sources';
import { adjustUnits, getUnits, saveUnits } from './units';

interface JobDef<P> {
  title: (params: P) => string;
  projectId?: (params: P) => string | null;
  run: (params: P, ctx: JobContext) => Promise<unknown>;
}

export function createApi(core: AppCore) {
  // ジョブの種類の登録簿。「もう一度試す」は、同じ種類・同じ引数で作り直す。
  const jobDefs = new Map<string, JobDef<never>>();
  function defineJob<P>(kind: string, def: JobDef<P>): (params: P) => JobInfo {
    jobDefs.set(kind, def as unknown as JobDef<never>);
    return (params: P) =>
      core.jobs.add({
        kind,
        title: def.title(params),
        projectId: def.projectId?.(params) ?? (params as { projectId?: string }).projectId ?? null,
        params,
        run: (ctx) => def.run(params, ctx),
      });
  }
  const subjectName = (projectId: string, subjectId: string) => getSubject(getProject(core, projectId), subjectId).name;

  const startPing = defineJob<Record<string, never>>('ping', {
    title: () => 'Claude との接続の確認',
    run: async (_p, ctx) => {
      const dir = core.dataDir();
      ensureDir(dir);
      ctx.progress('Claude の返事を待っています');
      const r = await callClaude({ projectDir: dir, kind: 'ping', vars: { note: '' }, schema: PingOutputSchema, env: core.claudeEnv(), signal: ctx.signal });
      return r.data;
    },
  });

  const startAdjustUnits = defineJob<{ projectId: string; subjectId: string }>('adjust_units', {
    title: (p) => `${subjectName(p.projectId, p.subjectId)}: 単元の調整`,
    run: async (p, ctx) => {
      const units = await adjustUnits(core, p.projectId, p.subjectId, ctx);
      return { note: units.note };
    },
  });

  const sourceTitle = (projectId: string, subjectId: string, sourceId: string) => getSource(core, projectId, subjectId, sourceId).title;

  const startReadSource = defineJob<{ projectId: string; subjectId: string; sourceId: string }>('read_source', {
    title: (p) => `${subjectName(p.projectId, p.subjectId)}: 「${sourceTitle(p.projectId, p.subjectId, p.sourceId)}」の読み取り`,
    run: async (p, ctx) => {
      const ex = await readSource(core, p.projectId, p.subjectId, p.sourceId, ctx);
      return { problems: ex.problems.length };
    },
  });

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
    /** 失敗・取り消しになったジョブを、同じ内容でもう一度並べる。 */
    retryJob: (id: string): JobInfo => {
      const job = core.jobs.get(id);
      if (!job) throw new Error('そのジョブはもうありません');
      const def = jobDefs.get(job.kind) as JobDef<unknown> | undefined;
      if (!def) throw new Error('このジョブはやり直せません');
      const params = job.params;
      return core.jobs.add({ kind: job.kind, title: job.title, projectId: job.projectId, params, run: (ctx) => def.run(params, ctx) });
    },
    /** Claude を呼べるかの確認(設定画面の「接続の確認」)。 */
    startPing: (): JobInfo => startPing({}),

    // ───── プロジェクト ─────
    subjectPresets: () => SUBJECT_PRESETS.map((p) => ({ name: p.name, group: p.group })),
    listProjects: () => listProjects(core),
    getProject: (projectId: string) => getProject(core, projectId),
    createProject: (input: ProjectInput) => createProject(core, input),
    updateProject: (projectId: string, input: ProjectInput) => updateProject(core, projectId, input),

    // ───── 単元 ─────
    getUnits: (projectId: string, subjectId: string) => getUnits(core, projectId, subjectId),
    saveUnits: (projectId: string, subjectId: string, tree: UnitNode[]) => saveUnits(core, projectId, subjectId, tree),
    startAdjustUnits: (projectId: string, subjectId: string): JobInfo => startAdjustUnits({ projectId, subjectId }),

    // ───── 資料の取り込み ─────
    importBegin: (projectId: string, subjectId: string, info: ImportBegin) => importBegin(core, projectId, subjectId, info),
    importOriginal: (projectId: string, subjectId: string, sourceId: string, bytes: Uint8Array, name: string) =>
      importOriginal(core, projectId, subjectId, sourceId, bytes, name),
    importPage: (projectId: string, subjectId: string, sourceId: string, pageNo: number, png: Uint8Array, text?: string) =>
      importPage(core, projectId, subjectId, sourceId, pageNo, png, text),
    importFinish: (projectId: string, subjectId: string, sourceId: string, pageCount: number) => importFinish(core, projectId, subjectId, sourceId, pageCount),
    listSources: (projectId: string, subjectId: string) => listSources(core, projectId, subjectId),
    getSource: (projectId: string, subjectId: string, sourceId: string) => getSource(core, projectId, subjectId, sourceId),
    deleteSource: (projectId: string, subjectId: string, sourceId: string) => deleteSource(core, projectId, subjectId, sourceId),
    readPageImage: (projectId: string, subjectId: string, sourceId: string, pageNo: number) => readPageImage(core, projectId, subjectId, sourceId, pageNo),

    // ───── 読み取りと補正 ─────
    startReadSource: (projectId: string, subjectId: string, sourceId: string): JobInfo => startReadSource({ projectId, subjectId, sourceId }),
    getExtracted: (projectId: string, subjectId: string, sourceId: string) => getExtracted(core, projectId, subjectId, sourceId),
  };
}

export type Api = ReturnType<typeof createApi>;
export type ApiMethod = keyof Api;
