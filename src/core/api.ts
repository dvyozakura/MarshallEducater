// 画面(renderer)から使える機能の一覧。ここに無いことは画面からはできない。
// Electron に依存しないので、単体テストからも同じ入口で呼べる。
import { resolve, sep } from 'node:path';
import { todayString } from '../shared/dates';
import { ENGINE_CAPS, ENGINE_IDS, ENGINE_LABEL, ENGINE_ROLES, ENGINE_SHORT, KIND_ROLE, type EngineAssign, type EngineId, type EngineRole } from '../shared/engines';
import { checkEngine } from './engine_check';
import type { JobInfo } from '../shared/jobs';
import { PingOutputSchema, type AppSettings, type ChatContext, type ProjectInput, type UnitNode } from '../shared/schema';
import { findUnit, SUBJECT_PRESETS } from '../shared/subjects';
import type { AppCore } from './app';
import { callClaude, ClaudeError } from './claude/task';
import { getTakeView, saveDraft, submitAnswers } from './answers';
import * as C from './correction';
import { createDaily, createScheduledMock, getReview, getTodayView, updateReviewFromGrading } from './daily';
import { createDesignedTest } from './diagnostic';
import { ensureDir } from './fsutil';
import { getGrading, getResultView, gradeTest, gradingTotals, onGraded, overrideGrade } from './grading';
import type { JobContext } from './jobs';
import { createProject, getProject, getSubject, listProjects, setProjectEngines, updateProject } from './projects';

/** 役割の代表のプロンプトの種類(割り当ての結果を見せるのに使う)。 */
function roleKind(role: EngineRole): string {
  return Object.entries(KIND_ROLE).find(([, r]) => r === role)?.[0] ?? 'ping';
}
import { createPlan, getPlanView } from './plan';
import { exportTestPdf, exportTextbookPdf, type TestPdfKind } from './print';
import { getQuality } from './quality';
import { getExtracted, readSource } from './reading';
import { deleteSource, getSource, importBegin, importFinish, importOriginal, importPage, listSources, readPageImage, type ImportBegin } from './sources';
import { answerChat, createNote, explainTest, findTextbookChat, getChat, getChatView, getNote, listChats, listNotes, missingExplanations, postQuestion, previewChatContext } from './teach';
import { activeChapterJob, CHAPTER_JOB_KIND, getChapterView, getTextbookView, setChapterRead, setChapterUnlearned, syncToc } from './textbook';
import { addSupplement, buildChapter, deferChapter, planBuildAll, setDeferred, takeDeferredForToday } from './textbook_build';
import { getTest, getVerify, listTests, verifyTotals } from './tests';
import { getTrendView, updateTrend } from './trend';
import { adjustUnits, getUnits, saveUnits } from './units';
import { getWeaknessView, TARGET_MASTERY, updateWeaknessFromGrading } from './weakness';

interface JobDef<P> {
  title: (params: P) => string;
  projectId?: (params: P) => string | null;
  run: (params: P, ctx: JobContext) => Promise<unknown>;
}

export function createApi(core: AppCore) {
  // 採点(と上書き)のあとに行うこと
  onGraded(updateWeaknessFromGrading);
  onGraded(updateReviewFromGrading);

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

  const startPing = defineJob<{ engine?: EngineId }>('ping', {
    title: (p) => `${ENGINE_SHORT[p.engine ?? 'claude']} との接続の確認`,
    run: async (p, ctx) => {
      if (p.engine) return checkEngine(core, p.engine, ctx);
      const dir = core.dataDir();
      ensureDir(dir);
      ctx.progress('Claude の返事を待っています');
      const r = await callClaude({ projectDir: dir, kind: 'ping', vars: { note: '' }, schema: PingOutputSchema, env: core.claudeEnv(), signal: ctx.signal, engine: 'claude' });
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

  const testTitle = (projectId: string, subjectId: string, testId: string) => getTest(core, projectId, subjectId, testId).title;

  const startGrade = defineJob<{ projectId: string; subjectId: string; testId: string }>('grade', {
    title: (p) => `「${testTitle(p.projectId, p.subjectId, p.testId)}」の採点`,
    run: async (p, ctx) => {
      const grading = await gradeTest(core, p.projectId, p.subjectId, p.testId, ctx);
      // 採点が済んだら、間違えた問題の解説づくりを続けて並べる(解説の失敗で採点を失敗にしない)
      const explainJobId = missingExplanations(grading, null).length > 0 ? startExplain({ projectId: p.projectId, subjectId: p.subjectId, testId: p.testId, all: true }).id : null;
      return { testId: p.testId, ...gradingTotals(grading), explainJobId };
    },
  });

  const startExplain = defineJob<{ projectId: string; subjectId: string; testId: string; all: boolean }>('explain', {
    title: (p) => `「${testTitle(p.projectId, p.subjectId, p.testId)}」の解説`,
    run: async (p, ctx) => {
      const ex = await explainTest(core, p.projectId, p.subjectId, p.testId, ctx, p.all);
      return { testId: p.testId, explained: ex.items.length };
    },
  });

  const startCreateNote = defineJob<{ projectId: string; subjectId: string; unitId: string }>('create_note', {
    title: (p) => `${subjectName(p.projectId, p.subjectId)}: 授業ノート「${findUnit(getUnits(core, p.projectId, p.subjectId).tree, p.unitId)?.name ?? p.unitId}」`,
    run: (p, ctx) => createNote(core, p.projectId, p.subjectId, p.unitId, ctx),
  });

  const startAnswerChat = defineJob<{ projectId: string; subjectId: string; chatId: string }>('chat', {
    title: (p) => `${subjectName(p.projectId, p.subjectId)}: 質問「${getChat(core, p.projectId, p.subjectId, p.chatId).title.slice(0, 20)}」`,
    run: async (p, ctx) => {
      const chat = await answerChat(core, p.projectId, p.subjectId, p.chatId, ctx);
      return { chatId: chat.id, messages: chat.messages.length };
    },
  });

  const startUpdateTrend = defineJob<{ projectId: string; subjectId: string }>('update_trend', {
    title: (p) => `${subjectName(p.projectId, p.subjectId)}: 志望校の傾向のまとめ`,
    run: async (p, ctx) => {
      const trend = await updateTrend(core, p.projectId, p.subjectId, ctx);
      return { basedOn: trend.basedOn.length };
    },
  });

  const startCreatePlan = defineJob<{ projectId: string; reason: string }>('create_plan', {
    title: (p) => `学習計画の${p.reason ? '作り直し' : '作成'}`,
    run: async (p, ctx) => {
      const plan = await createPlan(core, p.projectId, p.reason, ctx);
      return { weeks: plan.weeks.length, revision: plan.revision };
    },
  });

  const startCreateDaily = defineJob<{ projectId: string; subjectId: string }>('create_daily', {
    title: (p) => `${subjectName(p.projectId, p.subjectId)}: 今日の課題の作成`,
    run: async (p, ctx) => {
      const test = await createDaily(core, p.projectId, p.subjectId, ctx);
      return { testId: test.id, problems: test.problems.length };
    },
  });

  const startCreateMock = defineJob<{ projectId: string; subjectId: string }>('create_mock', {
    title: (p) => `${subjectName(p.projectId, p.subjectId)}: 通しの模擬試験の作成`,
    run: async (p, ctx) => {
      const test = await createScheduledMock(core, p.projectId, p.subjectId, ctx);
      return { testId: test.id, problems: test.problems.length };
    },
  });

  const chapterLabel = (projectId: string, subjectId: string, unitId: string) => {
    const chapters = syncToc(core, projectId, subjectId).chapters.filter((c) => !c.orphan);
    const i = chapters.findIndex((c) => c.unitId === unitId);
    const name = (i >= 0 ? chapters[i].title : (findUnit(getUnits(core, projectId, subjectId).tree, unitId)?.name ?? unitId)).split(' > ').at(-1);
    return i >= 0 ? `第${i + 1}章「${name}」` : `「${name}」`;
  };

  const startCreateChapterJob = defineJob<{ projectId: string; subjectId: string; unitId: string }>(CHAPTER_JOB_KIND, {
    title: (p) => `${subjectName(p.projectId, p.subjectId)}: 教材 ${chapterLabel(p.projectId, p.subjectId, p.unitId)}`,
    run: async (p, ctx) => {
      try {
        return await buildChapter(core, p.projectId, p.subjectId, p.unitId, ctx);
      } catch (e) {
        // 1日の上限で止まった章は、後日に回す(次の日に、続きから自動で作る)
        if (e instanceof ClaudeError && e.kind === 'daily_limit') deferChapter(core, p.projectId, p.subjectId, p.unitId);
        throw e;
      }
    },
  });
  const startSupplementJob = defineJob<{ projectId: string; subjectId: string; unitId: string; chatId: string }>('chapter_supplement', {
    title: (p) => `${subjectName(p.projectId, p.subjectId)}: 教材 ${chapterLabel(p.projectId, p.subjectId, p.unitId)} に質問を反映`,
    run: (p, ctx) => addSupplement(core, p.projectId, p.subjectId, p.unitId, p.chatId, ctx),
  });

  /** 章を作る(作り直す)。同じ章のジョブがすでに並んでいれば、それを返す(二重に作らない)。 */
  const startCreateChapter = (projectId: string, subjectId: string, unitId: string): JobInfo =>
    activeChapterJob(core, projectId, subjectId, unitId) ?? startCreateChapterJob({ projectId, subjectId, unitId });
  /** 後日に回した章のうち、今日作れる分のジョブを並べる。 */
  const resumeDeferred = (projectId: string, subjectId: string): JobInfo[] =>
    takeDeferredForToday(core, projectId, subjectId).map((unitId) => startCreateChapter(projectId, subjectId, unitId));

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
    updateSettings: (patch: Partial<AppSettings>): AppSettings => {
      // 接続確認の結果はアプリが書く。画面が持っている古い値で上書きしない
      const { engineStatus: _ignored, ...rest } = patch;
      return core.updateSettings(rest);
    },
    usage: () => ({ used: core.limiter.used(), limit: core.limiter.limit() }),
    /** エンジンごとの今日の呼び出し回数と上限。 */
    engineUsage: () => ENGINE_IDS.map((engine) => ({ engine, used: core.limiterFor(engine).used(), limit: core.limiterFor(engine).limit() })),
    /** 教員エンジンの一覧(設定画面): できること・接続確認の結果・役割ごとの割り当ての結果。 */
    engineInfo: (projectId?: string | null) => {
      const s = core.getSettings();
      const dir = projectId ? core.projectDir(projectId) : null;
      return {
        engines: ENGINE_IDS.map((engine) => ({
          engine,
          label: ENGINE_LABEL[engine],
          caps: ENGINE_CAPS[engine],
          status: s.engineStatus.find((x) => x.engine === engine) ?? { engine, status: 'unchecked' as const, version: '', message: '', checkedAt: null },
        })),
        /** いまの設定で、役割ごとに実際に使うエンジン(プロジェクトを渡せば、その上書きも含めて)。 */
        resolved: ENGINE_ROLES.map((role) => ({ role, ...core.resolveEngineFor(roleKind(role), dir) })),
      };
    },
    /** プロジェクトごとの割り当ての上書き(null でアプリ全体の設定に戻す)。 */
    setProjectEngines: (projectId: string, assign: EngineAssign | null) => setProjectEngines(core, projectId, assign),
    /** 設定画面の「品質」欄: 検算の結果、読み取りの補正率、採点の上書き。 */
    getQuality: () => getQuality(core),

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
    startPing: (engine?: EngineId): JobInfo => startPing(engine ? { engine } : {}),

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

    // ───── 採点 ─────
    startGrade: (projectId: string, subjectId: string, testId: string): JobInfo => startGrade({ projectId, subjectId, testId }),
    getResultView: (projectId: string, subjectId: string, testId: string) => getResultView(core, projectId, subjectId, testId),
    /** 採点結果の上書き(score が null なら取り消し)。 */
    overrideGrade: (projectId: string, subjectId: string, testId: string, problemId: string, score: number | null, note: string) =>
      overrideGrade(core, projectId, subjectId, testId, problemId, score, note),

    // ───── 解説・授業ノート・質問 ─────
    /** 解説を作る。all = false なら、まだ解説の無い(間違えた)設問だけ。 */
    startExplain: (projectId: string, subjectId: string, testId: string, all = false): JobInfo => startExplain({ projectId, subjectId, testId, all }),
    listNotes: (projectId: string, subjectId: string) => listNotes(core, projectId, subjectId),
    getNote: (projectId: string, subjectId: string, unitId: string) => getNote(core, projectId, subjectId, unitId),
    startCreateNote: (projectId: string, subjectId: string, unitId: string): JobInfo => startCreateNote({ projectId, subjectId, unitId }),
    listChats: (projectId: string, subjectId: string) => listChats(core, projectId, subjectId),
    getChatView: (projectId: string, subjectId: string, chatId: string) => getChatView(core, projectId, subjectId, chatId),
    previewChatContext: (projectId: string, subjectId: string, context: Partial<ChatContext>) => previewChatContext(core, projectId, subjectId, context),
    /** 質問する(chatId が無ければ新しいやりとり)。質問を保存してから、答えのジョブを並べる。 */
    askQuestion: (projectId: string, subjectId: string, input: { chatId?: string | null; context?: Partial<ChatContext>; question: string; quote?: string | null }): { chatId: string; job: JobInfo } => {
      const chat = postQuestion(core, projectId, subjectId, input);
      return { chatId: chat.id, job: startAnswerChat({ projectId, subjectId, chatId: chat.id }) };
    },

    // ───── 体系的な教材 ─────
    /** 「教材」タブの目次(章の状態・既読・未習・確認問題の結果)。 */
    getTextbookView: (projectId: string, subjectId: string) => {
      resumeDeferred(projectId, subjectId);
      return getTextbookView(core, projectId, subjectId);
    },
    /** 章を読む画面の内容(章の中身、前後の章、点検の記録)。 */
    getChapterView: (projectId: string, subjectId: string, unitId: string) => getChapterView(core, projectId, subjectId, unitId),
    /** 教材を PDF に出す。unitId が null なら、作成済みの章すべて(科目全体)。 */
    exportTextbookPdf: (projectId: string, subjectId: string, unitId: string | null) => exportTextbookPdf(core, projectId, subjectId, unitId),
    /** 章を作る・作り直す(1章 = 1ジョブ)。 */
    startCreateChapter,
    /** 「まとめて作る」の見込み(未作成の章の数、呼び出しの見込み数、今日作れる数)。始める前に見せて確認を取る。 */
    planBuildAll: (projectId: string, subjectId: string) => planBuildAll(core, projectId, subjectId),
    /** 未作成の章を順にジョブへ入れる。1日の上限を超える分は翌日に回す(toc.json に残す)。 */
    startBuildAll: (projectId: string, subjectId: string): { jobs: JobInfo[]; deferred: string[] } => {
      const plan = planBuildAll(core, projectId, subjectId);
      setDeferred(core, projectId, subjectId, plan.later);
      return { jobs: plan.today.map((unitId) => startCreateChapter(projectId, subjectId, unitId)), deferred: plan.later };
    },
    /** 後日に回した章の予約を取り消す。 */
    cancelDeferred: (projectId: string, subjectId: string): void => setDeferred(core, projectId, subjectId, []),
    /** 全プロジェクトの、後日に回した章の続きを始める(起動時と、動いている間ときどき呼ぶ)。 */
    resumeDeferredChapters: (): JobInfo[] => {
      const jobs: JobInfo[] = [];
      for (const p of listProjects(core).projects) {
        for (const s of p.subjects) {
          try {
            jobs.push(...resumeDeferred(p.id, s.id));
          } catch {
            /* 壊れた科目があっても、ほかの科目は続ける */
          }
        }
      }
      return jobs;
    },
    /** 教材への質問の、いちばん新しいやりとり(chapterUnitId が null なら、科目全体についての質問)。無ければ null。 */
    findTextbookChat: (projectId: string, subjectId: string, chapterUnitId: string | null) => findTextbookChat(core, projectId, subjectId, { chapterUnitId }),
    /** 「教材に反映」: 章への質問のやりとりをもとに、その章へ補足を追記する(追記前の版は残す。追記分も点検する)。 */
    startSupplement: (projectId: string, subjectId: string, unitId: string, chatId: string): JobInfo => {
      const busy = core.jobs.list().find((j) => j.kind === 'chapter_supplement' && (j.status === 'queued' || j.status === 'running') && (j.params as { chatId?: string }).chatId === chatId);
      return busy ?? startSupplementJob({ projectId, subjectId, unitId, chatId });
    },
    setChapterRead: (projectId: string, subjectId: string, unitId: string, read: boolean) => setChapterRead(core, projectId, subjectId, unitId, read),
    setChapterUnlearned: (projectId: string, subjectId: string, unitId: string, unlearned: boolean) => setChapterUnlearned(core, projectId, subjectId, unitId, unlearned),

    // ───── 今日の課題 ─────
    getTodayView: (projectId: string) => getTodayView(core, projectId),
    getReview: (projectId: string, subjectId: string) => getReview(core, projectId, subjectId),
    startCreateDaily: (projectId: string, subjectId: string): JobInfo => startCreateDaily({ projectId, subjectId }),
    /** 今日あつかう科目のうち、まだ課題が無いものをまとめて作る。 */
    startCreateToday: (projectId: string): JobInfo[] =>
      getTodayView(core, projectId)
        .subjects.filter((s) => !s.test)
        .map((s) => startCreateDaily({ projectId, subjectId: s.subjectId })),
    startCreateMock: (projectId: string, subjectId: string): JobInfo => startCreateMock({ projectId, subjectId }),

    // ───── 学習計画 ─────
    getPlanView: (projectId: string) => getPlanView(core, projectId),
    /** 学習計画を作る。reason を渡すと「作り直し」(理由を Claude に伝える)。 */
    startCreatePlan: (projectId: string, reason = ''): JobInfo => startCreatePlan({ projectId, reason }),

    // ───── 志望校の傾向 ─────
    getTrendView: (projectId: string, subjectId: string) => getTrendView(core, projectId, subjectId),
    startUpdateTrend: (projectId: string, subjectId: string): JobInfo => startUpdateTrend({ projectId, subjectId }),

    /** ダッシュボード用: 最近の結果(採点済みのテスト、新しい順)。 */
    recentResults: (projectId: string, limit = 6) =>
      getProject(core, projectId)
        .subjects.flatMap((s) =>
          listTests(core, projectId, s.id)
            .filter((t) => t.status === 'graded')
            .map((t) => {
              const g = getGrading(core, projectId, s.id, t.id);
              if (!g) return null;
              const totals = gradingTotals(g);
              return { subjectId: s.id, testId: t.id, title: t.title, kind: t.kind, gradedAt: g.gradedAt, ...totals, rate: totals.max > 0 ? Math.round((totals.score / totals.max) * 100) : 0 };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null),
        )
        .sort((a, b) => b.gradedAt.localeCompare(a.gradedAt))
        .slice(0, limit),

    // ───── 苦手マップ ─────
    getWeaknessView: (projectId: string, subjectId: string) => getWeaknessView(core, projectId, subjectId),
    /** ダッシュボード用: 科目ごとの習熟度と、目標との差。 */
    subjectSummaries: (projectId: string) => {
      const project = getProject(core, projectId);
      const target = TARGET_MASTERY[project.targetLevel];
      return project.subjects.map((s) => {
        const w = getWeaknessView(core, projectId, s.id);
        return { subjectId: s.id, name: s.name, mastery: w.overall, target, gap: w.overall === null ? null : Math.round((target - w.overall) * 10) / 10, testedUnits: w.rows.length, untestedUnits: w.untested, weakest: w.rows.slice(0, 3).map((r) => ({ unitName: r.unitName, mastery: r.mastery })) };
      });
    },

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
