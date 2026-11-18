// 画面(renderer)から使える機能の一覧。ここに無いことは画面からはできない。
// Electron に依存しないので、単体テストからも同じ入口で呼べる。
import { resolve, sep } from 'node:path';
import { todayString } from '../shared/dates';
import type { JobInfo } from '../shared/jobs';
import { PingOutputSchema, type AppSettings, type ProjectInput, type UnitNode } from '../shared/schema';
import { SUBJECT_PRESETS } from '../shared/subjects';
import type { AppCore } from './app';
import { callClaude } from './claude/task';
import { getTakeView, saveDraft, submitAnswers } from './answers';
import * as C from './correction';
import { createDesignedTest } from './diagnostic';
import { ensureDir } from './fsutil';
import type { JobContext } from './jobs';
import { createProject, getProject, getSubject, listProjects, updateProject } from './projects';
import { exportTestPdf, type TestPdfKind } from './print';
import { getExtracted, readSource } from './reading';
import { deleteSource, getSource, importBegin, importFinish, importOriginal, importPage, listSources, readPageImage, type ImportBegin } from './sources';
import { getTest, getVerify, listTests, verifyTotals } from './tests';
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
      C.afterReadSource(core, p.projectId, p.subjectId, p.sourceId);
      return { problems: ex.problems.length };
    },
  });

  const startRereadProblem = defineJob<{ projectId: string; subjectId: string; sourceId: string; problemId: string; hint: string }>('reread_problem', {
    title: (p) => `${subjectName(p.projectId, p.subjectId)}: 「${sourceTitle(p.projectId, p.subjectId, p.sourceId)}」の一部を読み直し`,
    run: async (p, ctx) => {
      const q = await C.rereadProblem(core, p.projectId, p.subjectId, p.sourceId, p.problemId, p.hint, ctx);
      return { problemId: q.id };
    },
  });

  const startCreateDiagnostic = defineJob<{ projectId: string; subjectId: string }>('create_diagnostic', {
    title: (p) => `${subjectName(p.projectId, p.subjectId)}: 実力診断テストの作成`,
    run: async (p, ctx) => {
      const test = await createDesignedTest(core, p.projectId, p.subjectId, 'diagnostic', ctx);
      return { testId: test.id, problems: test.problems.length };
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
      /** テスト用: 解く画面の時計を速める倍率。 */
      timerSpeed: Math.max(1, Number(process.env.ME_TIMER_SPEED) || 1),
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
    getCorrectionView: (projectId: string, subjectId: string, sourceId: string) => C.getCorrectionView(core, projectId, subjectId, sourceId),
    getCorrections: (projectId: string, subjectId: string, sourceId: string) => C.getCorrections(core, projectId, subjectId, sourceId),
    updateProblem: (projectId: string, subjectId: string, sourceId: string, problemId: string, patch: C.ProblemPatch) =>
      C.updateProblem(core, projectId, subjectId, sourceId, problemId, patch),
    resolveUncertain: (projectId: string, subjectId: string, sourceId: string, problemId: string, index: number) =>
      C.resolveUncertain(core, projectId, subjectId, sourceId, problemId, index),
    splitProblem: (projectId: string, subjectId: string, sourceId: string, problemId: string, at: number) => C.splitProblem(core, projectId, subjectId, sourceId, problemId, at),
    mergeWithNext: (projectId: string, subjectId: string, sourceId: string, problemId: string) => C.mergeWithNext(core, projectId, subjectId, sourceId, problemId),
    moveProblem: (projectId: string, subjectId: string, sourceId: string, problemId: string, delta: number) => C.moveProblem(core, projectId, subjectId, sourceId, problemId, delta),
    deleteProblem: (projectId: string, subjectId: string, sourceId: string, problemId: string) => C.deleteProblem(core, projectId, subjectId, sourceId, problemId),
    saveFigure: (projectId: string, subjectId: string, sourceId: string, problemId: string, input: C.FigureInput) => C.saveFigure(core, projectId, subjectId, sourceId, problemId, input),
    deleteFigure: (projectId: string, subjectId: string, sourceId: string, problemId: string, figureId: string) => C.deleteFigure(core, projectId, subjectId, sourceId, problemId, figureId),
    readFigureImage: (projectId: string, subjectId: string, sourceId: string, image: string) => C.readFigureImage(core, projectId, subjectId, sourceId, image),
    confirmProblem: (projectId: string, subjectId: string, sourceId: string, problemId: string, confirmed: boolean) =>
      C.confirmProblem(core, projectId, subjectId, sourceId, problemId, confirmed),
    confirmSource: (projectId: string, subjectId: string, sourceId: string) => C.confirmSource(core, projectId, subjectId, sourceId),
    unconfirmSource: (projectId: string, subjectId: string, sourceId: string) => C.unconfirmSource(core, projectId, subjectId, sourceId),
    startRereadProblem: (projectId: string, subjectId: string, sourceId: string, problemId: string, hint: string): JobInfo =>
      startRereadProblem({ projectId, subjectId, sourceId, problemId, hint }),

    // ───── テスト ─────
    listTests: (projectId: string, subjectId: string) => listTests(core, projectId, subjectId),
    getTest: (projectId: string, subjectId: string, testId: string) => getTest(core, projectId, subjectId, testId),
    getVerify: (projectId: string, subjectId: string, testId: string) => getVerify(core, projectId, subjectId, testId),
    verifyTotals: () => verifyTotals(core),
    startCreateDiagnostic: (projectId: string, subjectId: string): JobInfo => startCreateDiagnostic({ projectId, subjectId }),

    // ───── 解く・答案を出す ─────
    getTakeView: (projectId: string, subjectId: string, testId: string) => getTakeView(core, projectId, subjectId, testId),
    saveDraft: (projectId: string, subjectId: string, testId: string, input: { answers: Record<string, string>; elapsedSec: number; extended?: boolean }) =>
      saveDraft(core, projectId, subjectId, testId, input),
    submitAnswers: (projectId: string, subjectId: string, testId: string, input: { answers: Record<string, string>; elapsedSec: number | null }) =>
      submitAnswers(core, projectId, subjectId, testId, input),
    /** 問題冊子・解答用紙を PDF に出す。保存した場所を返す。 */
    exportTestPdf: (projectId: string, subjectId: string, testId: string, which: TestPdfKind) => exportTestPdf(core, projectId, subjectId, testId, which),
    /** 保存したファイルをエクスプローラーで表示する(データフォルダの中だけ)。 */
    revealFile: (path: string): void => {
      const full = resolve(path);
      if (!full.startsWith(resolve(core.dataDir()) + sep)) throw new Error('データフォルダの外のファイルは開けません');
      core.revealFile?.(full);
    },
  };
}

export type Api = ReturnType<typeof createApi>;
export type ApiMethod = keyof Api;
