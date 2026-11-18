// 体系的な教材: 章を作る(本文 → 例題・確認問題の作成と検算 → 点検 → 指摘があれば1回修正 → 保存)、まとめて作る。
import { copyFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { todayString } from '../shared/dates';
import { choiceMark } from '../shared/labels';
import { isUsableSvg } from '../shared/mdmath';
import {
  ChapterBodyOutputSchema,
  ChapterReviewOutputSchema,
  ChapterReviseOutputSchema,
  ChapterSupplementOutputSchema,
  DIFFICULTY_LABEL,
  FORMAT_VERSION,
  MISTAKE_LABEL,
  PROBLEM_FORMAT_LABEL,
  THICKNESS_LABEL,
  type Chapter,
  type ChapterExample,
  type ChapterFigure,
  type ChapterIssue,
  type ChapterReviewRecord,
  type Project,
  type VerifyOutcome,
} from '../shared/schema';
import type { AppCore } from './app';
import { callClaude } from './claude/task';
import { ensureDir, readTextIfExists, safeFileName, writeFileAtomic } from './fsutil';
import { generateVerified, type ProblemRequest } from './generate';
import type { JobContext } from './jobs';
import { getProject, getSubject } from './projects';
import { Files, readDataOr, writeData } from './store';
import { getChat, unitMistakes } from './teach';
import { CHAPTER_JOB_KIND, chapterFileId, chapterSpec, getChapter, syncToc, textbookPaths, updateTocChapter } from './textbook';
import { saveTest } from './tests';
import { getTrend } from './trend';
import { projectBrief } from './units';
import { getWeaknessView } from './weakness';

// ───── 数値は暫定(DECISIONS.md に記録) ─────
/** 1章を作るのにかかる呼び出しの目安(本文 1+問題づくり 1+解き直し 1+照らし合わせ 0〜1+点検 1+修正 0〜1)。 */
export const CHAPTER_CALLS_ESTIMATE = 5;
/** 1章の呼び出しの最大(本文 1+問題づくりと検算 9+点検 1+修正 1。型違いのやり直しは別)。 */
export const CHAPTER_CALLS_MAX = 12;
/** 確認問題の制限時間(1問あたり、分)。 */
export const QUIZ_MINUTES_PER_PROBLEM = 8;
/** 章づくりに添える授業ノートの長さの上限(字)。 */
const NOTE_REF_MAX = 3000;

// ───────── 人が読む版(Markdown) ─────────

/** 本文中の `[[図ID]]` の行を、図の説明の文に置き換える(Markdown の版には SVG を入れない)。 */
function figuresAsText(text: string, figures: ChapterFigure[]): string {
  return text.replace(/^[ \t]*\[\[([A-Za-z0-9_-]+)\]\][ \t]*$/gm, (_m, id: string) => {
    const f = figures.find((x) => x.id === id);
    return f ? `(図: ${f.caption || id})` : '';
  });
}

function exampleAnswer(e: ChapterExample): string {
  if (e.format !== 'choice') return e.answer;
  const n = Number(e.answer.normalize('NFKC').match(/\d+/)?.[0] ?? NaN);
  return Number.isFinite(n) && e.choices[n - 1] !== undefined ? `${choiceMark(n - 1)} ${e.choices[n - 1]}` : e.answer;
}

/** 章を、人と Claude Code が読める Markdown にする(chapters/<単元ID>.md)。構成は「導入 → 要点 → 例題 → よくある誤り →(補足)→ 確認問題」。 */
export function chapterMarkdown(ch: Chapter, no: number): string {
  const name = ch.title.split(' > ').at(-1) ?? ch.title;
  const lines = [
    `# ${no > 0 ? `第${no}章 ` : ''}${name}`,
    '',
    `${ch.title} / 第 ${ch.chapterVersion} 版(${ch.updatedAt.slice(0, 10)})/ 厚さ: ${THICKNESS_LABEL[ch.thickness]}${ch.unlearned ? '・未習の単元として作成' : ''}`,
    '',
    '## 導入',
    '',
    figuresAsText(ch.intro.trim(), ch.figures),
    '',
    '## 要点',
    '',
    figuresAsText(ch.points.trim(), ch.figures),
    '',
    '## 例題',
    '',
  ];
  ch.examples.forEach((e, i) => {
    lines.push(`### 例題${i + 1}(${DIFFICULTY_LABEL[e.difficulty]}・${PROBLEM_FORMAT_LABEL[e.format]})`, '');
    if (e.focus.trim()) lines.push(`ねらい: ${e.focus.trim()}`, '');
    lines.push(e.body.trim(), '', ...e.choices.map((c, k) => `- ${choiceMark(k)} ${c}`), ...(e.choices.length ? [''] : []));
    if (e.figureSvg) lines.push('(図はアプリの画面で表示されます)', '');
    lines.push(`**解答** ${exampleAnswer(e)}`, '', '**解説**', '', e.solution.trim() || '(解説なし)', '');
  });
  lines.push('## よくある誤り', '', figuresAsText(ch.pitfalls.trim(), ch.figures), '');
  if (ch.supplements.length) {
    lines.push('## 補足(質問から)', '');
    for (const s of ch.supplements) lines.push(`### ${s.title.trim()}`, '', s.markdown.trim(), '');
  }
  lines.push('## 確認問題', '');
  if (ch.quiz.length === 0) lines.push('(この版には、確認問題がありません)', '');
  ch.quiz.forEach((q, i) => {
    lines.push(`**${i + 1}.**(${DIFFICULTY_LABEL[q.difficulty]}・${PROBLEM_FORMAT_LABEL[q.format]}・${q.points} 点)${q.body.trim()}`, '', ...q.choices.map((c, k) => `- ${choiceMark(k)} ${c}`), ...(q.choices.length ? [''] : []));
  });
  if (ch.quizTestId) lines.push(`答え合わせは、アプリの「確認問題を解く」から(採点して苦手マップに反映します)。テスト ID: ${ch.quizTestId}`, '');
  return lines.join('\n');
}

// ───────── 点検と修正(章の本文・補足で共通) ─────────

export interface ReviewTarget {
  projectId: string;
  subjectName: string;
  project: Project;
  chapterTitle: string;
  target: 'chapter' | 'supplement';
  /** 点検する文章(部分の名前 → 本文)。 */
  sections: Partial<Record<ChapterIssue['section'], string>>;
  figures: ChapterFigure[];
  examples: ChapterExample[];
  /** 補足の点検のとき、章の要点。 */
  context?: string | null;
}

export interface ReviewOutcome {
  sections: Partial<Record<ChapterIssue['section'], string>>;
  figures: ChapterFigure[];
  issues: ChapterIssue[];
  comment: string;
  revised: boolean;
}

const usableFigures = (figures: ChapterFigure[]): ChapterFigure[] => figures.filter((f) => isUsableSvg(f.svg));

/**
 * 別の呼び出しで、事実・計算・用語を点検する。指摘があれば、1回だけ直させる(直したあとの再点検はしない)。
 */
export async function reviewAndRevise(core: AppCore, t: ReviewTarget, ctx: JobContext): Promise<ReviewOutcome> {
  const names = Object.keys(t.sections) as Array<ChapterIssue['section']>;
  const examples = t.examples.map((e) => ({ body: e.body, choices: e.choices, answer: e.answer, solution: e.solution }));
  const vars = { subjectName: t.subjectName, chapterTitle: t.chapterTitle };
  ctx.progress(t.target === 'chapter' ? '別の呼び出しで、本文の事実・計算・用語を点検しています' : '別の呼び出しで、補足の事実・計算・用語を点検しています');
  const review = await callClaude({
    projectDir: core.projectDir(t.projectId),
    kind: 'chapter_review',
    vars,
    input: { project: projectBrief(t.project), chapter: t.chapterTitle, target: t.target, sections: t.sections, examples, context: t.context ?? null },
    schema: ChapterReviewOutputSchema,
    env: core.claudeEnv(),
    signal: ctx.signal,
  });
  // 点検の対象でない部分への指摘は捨てる
  const issues = review.data.issues.filter((i) => names.includes(i.section));
  if (issues.length === 0) return { sections: t.sections, figures: t.figures, issues, comment: review.data.comment, revised: false };

  ctx.progress(`点検で ${issues.length} 件の指摘がありました。直しています`);
  const flagged = [...new Set(issues.map((i) => i.section))];
  const revise = await callClaude({
    projectDir: core.projectDir(t.projectId),
    kind: 'chapter_revise',
    vars,
    input: { project: projectBrief(t.project), chapter: t.chapterTitle, target: t.target, sections: t.sections, figures: t.figures, issues, examples },
    schema: ChapterReviseOutputSchema,
    env: core.claudeEnv(),
    signal: ctx.signal,
    check: (d) => {
      const missing = flagged.find((s) => !(d[s] ?? '').trim());
      return missing ? `指摘のあった部分 ${missing} の、直したあとの全文がありません(指摘のあった部分は null にしない)。` : null;
    },
  });
  const sections = { ...t.sections };
  for (const s of names) {
    const text = revise.data[s];
    if (text && text.trim()) sections[s] = text.trim();
  }
  const figures = revise.data.figures.length ? usableFigures(revise.data.figures) : t.figures;
  return { sections, figures, issues, comment: review.data.comment, revised: true };
}

/** 点検の結果を review/<単元ID>.json に足す。 */
export function appendReviewRecord(core: AppCore, projectId: string, subjectId: string, unitId: string, record: ChapterReviewRecord): void {
  const f = textbookPaths(core, projectId, subjectId).review(chapterFileId(unitId));
  const cur = readDataOr(f, Files.chapterReview, () => ({ version: FORMAT_VERSION, unitId, records: [] }));
  writeData(f, Files.chapterReview, { ...cur, records: [...cur.records, record] });
}

/** いまの版を versions/ に残す(作り直し・補足の追記の前に呼ぶ)。 */
export function keepVersion(core: AppCore, projectId: string, subjectId: string, ch: Chapter): void {
  const tb = textbookPaths(core, projectId, subjectId);
  const id = chapterFileId(ch.unitId);
  ensureDir(dirname(tb.versionJson(id, ch.chapterVersion)));
  copyFileSync(tb.chapterJson(id), tb.versionJson(id, ch.chapterVersion));
  if (existsSync(tb.chapterMd(id))) copyFileSync(tb.chapterMd(id), tb.versionMd(id, ch.chapterVersion));
}

/** 章を保存する(アプリが読む .json と、人が読む .md)。 */
export function writeChapter(core: AppCore, projectId: string, subjectId: string, ch: Chapter, no: number): Chapter {
  const tb = textbookPaths(core, projectId, subjectId);
  const id = chapterFileId(ch.unitId);
  const saved = writeData(tb.chapterJson(id), Files.chapter, ch);
  writeFileAtomic(tb.chapterMd(id), chapterMarkdown(saved, no));
  return saved;
}

// ───────── 章を作る ─────────

export interface BuildResult {
  unitId: string;
  chapterVersion: number;
  examples: number;
  quiz: number;
  issues: number;
  revised: boolean;
  quizTestId: string | null;
  verify: Record<VerifyOutcome, number>;
}

/**
 * 1つの章を作る(または作り直す)。
 * ①本文(導入・要点・よくある誤り・例題のねらい)→ ②例題と確認問題を作って検算 → ③本文を別の呼び出しで点検 → ④指摘があれば1回直す → ⑤保存。
 * 作り直しのときは、前の版を versions/ に残す。
 */
export async function buildChapter(core: AppCore, projectId: string, subjectId: string, unitId: string, ctx: JobContext): Promise<BuildResult> {
  const project = getProject(core, projectId);
  const subject = getSubject(project, subjectId);
  const toc = syncToc(core, projectId, subjectId);
  const ordered = toc.chapters.filter((c) => !c.orphan);
  const index = ordered.findIndex((c) => c.unitId === unitId);
  if (index < 0) throw new Error('その単元は、この科目の単元ツリー(出題の対象)にありません。章を作れません。');
  const entry = ordered[index];
  const no = index + 1;
  const unitName = entry.title.split(' > ').at(-1) ?? entry.title;
  const row = getWeaknessView(core, projectId, subjectId).rows.find((r) => r.unitId === unitId) ?? null;
  const mastery = row?.mastery ?? null;
  const spec = chapterSpec(mastery, entry.unlearned, project.examType);
  const trend = getTrend(core, projectId, subjectId);
  const previous = getChapter(core, projectId, subjectId, unitId);
  const note = readTextIfExists(core.paths(projectId).subject(subjectId).note(safeFileName(unitId)));
  const vars = { subjectName: subject.name, chapterNo: String(no), unitName };

  // ① 本文
  ctx.progress(`第${no}章「${unitName}」の本文を書いています(${THICKNESS_LABEL[spec.thickness]})`);
  const body = await callClaude({
    projectDir: core.projectDir(projectId),
    kind: 'chapter_body',
    vars,
    input: {
      subject: subject.name,
      project: projectBrief(project),
      chapter: { no, title: entry.title, unitName },
      previousChapter: ordered[index - 1]?.title ?? null,
      nextChapter: ordered[index + 1]?.title ?? null,
      toc: ordered.map((c, i) => `第${i + 1}章 ${c.title}`),
      spec: { thickness: spec.thickness, chars: spec.chars, style: spec.style, examples: spec.examples },
      unlearned: entry.unlearned,
      weakness: row ? { mastery: row.mastery, attempts: row.attempts, mistakes: Object.fromEntries(Object.entries(row.mistakes).map(([m, n]) => [MISTAKE_LABEL[m as keyof typeof MISTAKE_LABEL], n])) } : null,
      mistakes: unitMistakes(core, projectId, subjectId, unitId),
      trend: trend ? { format: trend.format, frequentUnits: trend.frequentUnits, difficulty: trend.difficulty } : null,
      note: note ? note.slice(0, NOTE_REF_MAX) : null,
      previous: previous ? { intro: previous.intro, points: previous.points, pitfalls: previous.pitfalls } : null,
    },
    schema: ChapterBodyOutputSchema,
    env: core.claudeEnv(),
    signal: ctx.signal,
    check: (d) => {
      for (const k of ['intro', 'points', 'pitfalls'] as const) if (d[k].trim().length < 10) return `${k} が短すぎます。章の本文として読める内容を書いてください。`;
      return null;
    },
  });

  // ② 例題と確認問題(セッション1の「問題の作成と検算」の仕組み)
  const nEx = spec.examples.length;
  const requests: ProblemRequest[] = [
    ...spec.examples.map((e, i) => ({ unitId, difficulty: e.difficulty, format: e.format, origin: 'example' as const, focus: body.data.exampleFocus[i]?.trim() || null })),
    ...spec.quiz.map((q) => ({ unitId, difficulty: q.difficulty, format: q.format, origin: 'textbook' as const })),
  ];
  const gen = await generateVerified(core, { projectId, subjectId, purpose: `教材 第${no}章「${unitName}」の例題と確認問題`, requests }, ctx);
  const exampleProblems = gen.problems.filter((p) => p.slot < nEx);
  const quizProblems = gen.problems.filter((p) => p.slot >= nEx);
  if (exampleProblems.length === 0) {
    throw new Error(`検算に通る例題を1つも作れませんでした(作り直し ${gen.counts.regenerated}、破棄 ${gen.counts.discarded})。もう一度試してください。`);
  }
  const examples: ChapterExample[] = exampleProblems.map((p) => ({
    difficulty: p.problem.difficulty,
    format: p.problem.format,
    focus: p.request.focus ?? '',
    body: p.problem.body,
    choices: p.problem.choices,
    figureSvg: p.problem.figureSvg,
    answer: p.problem.answer,
    solution: p.problem.solution,
  }));

  // ③ 点検 → ④ 指摘があれば1回直す
  const reviewed = await reviewAndRevise(
    core,
    {
      projectId,
      subjectName: subject.name,
      project,
      chapterTitle: `第${no}章 ${entry.title}`,
      target: 'chapter',
      sections: { intro: body.data.intro.trim(), points: body.data.points.trim(), pitfalls: body.data.pitfalls.trim() },
      figures: usableFigures(body.data.figures),
      examples,
    },
    ctx,
  );

  // ⑤ 保存。前の版は versions/ に残す
  ctx.progress('章を保存しています');
  if (previous) keepVersion(core, projectId, subjectId, previous);
  const chapterVersion = (previous?.chapterVersion ?? 0) + 1;
  const quizTest =
    quizProblems.length > 0
      ? saveTest(
          core,
          projectId,
          subjectId,
          {
            kind: 'practice',
            title: `第${no}章「${unitName}」の確認問題${chapterVersion > 1 ? `(第 ${chapterVersion} 版)` : ''}`,
            timeLimitMin: quizProblems.length * QUIZ_MINUTES_PER_PROBLEM,
            instructions: '教材の章を読んだあとの確認問題です。章を見ずに解いてみましょう。',
            chapterUnitId: unitId,
          },
          // 検算の記録は、確認問題の分だけをテストに残す(例題の分は、点検結果の記録に入れる)
          { problems: quizProblems, events: gen.events.filter((e) => e.slot >= nEx) },
        )
      : null;
  const at = new Date().toISOString();
  const chapter = writeChapter(
    core,
    projectId,
    subjectId,
    {
      version: FORMAT_VERSION,
      unitId,
      title: entry.title,
      chapterVersion,
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
      thickness: spec.thickness,
      unlearned: entry.unlearned,
      masteryAtBuild: mastery,
      intro: reviewed.sections.intro ?? '',
      points: reviewed.sections.points ?? '',
      pitfalls: reviewed.sections.pitfalls ?? '',
      figures: reviewed.figures,
      examples,
      quiz: (quizTest?.problems ?? []).map((p) => ({ problemId: p.id, difficulty: p.difficulty, format: p.format, body: p.body, choices: p.choices, figureSvg: p.figureSvg, points: p.points })),
      quizTestId: quizTest?.id ?? null,
      // 質問から足した補足は、作り直しても引き継ぐ
      supplements: previous?.supplements ?? [],
    },
    no,
  );
  const exampleCounts: Record<VerifyOutcome, number> = { adopted: 0, regenerated: 0, discarded: 0 };
  for (const e of gen.events) if (e.slot < nEx) exampleCounts[e.outcome]++;
  appendReviewRecord(core, projectId, subjectId, unitId, { at, chapterVersion, target: 'chapter', issues: reviewed.issues, comment: reviewed.comment, revised: reviewed.revised, verify: exampleCounts });
  updateTocChapter(core, projectId, subjectId, unitId, {
    chapterVersion,
    builtAt: at,
    thickness: spec.thickness,
    masteryAtBuild: mastery,
    unlearnedAtBuild: entry.unlearned,
    quizTestId: chapter.quizTestId,
  });
  return { unitId, chapterVersion, examples: examples.length, quiz: chapter.quiz.length, issues: reviewed.issues.length, revised: reviewed.revised, quizTestId: chapter.quizTestId, verify: gen.counts };
}

// ───────── 教材に反映(質問のやりとりから補足を追記) ─────────

export interface SupplementResult {
  unitId: string;
  chapterVersion: number;
  title: string;
  issues: number;
  revised: boolean;
}

/**
 * 章への質問のやりとりをもとに、その章へ補足を追記する。
 * 補足は別の呼び出しで点検し、指摘があれば1回直す。追記前の版は versions/ に残す。
 */
export async function addSupplement(core: AppCore, projectId: string, subjectId: string, unitId: string, chatId: string, ctx: JobContext): Promise<SupplementResult> {
  const project = getProject(core, projectId);
  const subject = getSubject(project, subjectId);
  const before = getChapter(core, projectId, subjectId, unitId);
  if (!before) throw new Error('この章は、まだ作っていません。補足は、章を作ってから足せます。');
  const chat = getChat(core, projectId, subjectId, chatId);
  if (chat.context.chapterUnitId !== unitId) throw new Error('この質問は、この章についてのものではありません。');
  if (!chat.messages.some((m) => m.role === 'assistant')) throw new Error('まだ答えの付いた質問がありません。質問して答えが付いてから「教材に反映」してください。');
  const toc = syncToc(core, projectId, subjectId);
  const ordered = toc.chapters.filter((c) => !c.orphan);
  const index = ordered.findIndex((c) => c.unitId === unitId);
  const no = index + 1;
  const chapterTitle = `${no > 0 ? `第${no}章 ` : ''}${before.title}`;
  const row = getWeaknessView(core, projectId, subjectId).rows.find((r) => r.unitId === unitId) ?? null;

  ctx.progress('質問のやりとりをもとに、補足を書いています');
  const sup = await callClaude({
    projectDir: core.projectDir(projectId),
    kind: 'chapter_supplement',
    vars: { subjectName: subject.name, chapterTitle },
    input: {
      project: projectBrief(project),
      chapter: {
        title: chapterTitle,
        intro: before.intro,
        points: before.points,
        pitfalls: before.pitfalls,
        examples: before.examples.map((e) => ({ body: e.body, answer: e.answer, solution: e.solution })),
        supplements: before.supplements.map((s) => ({ title: s.title, markdown: s.markdown })),
      },
      conversation: chat.messages.map((m) => ({ role: m.role, text: m.text, quote: m.quote ?? null })),
      weakness: row ? { mastery: row.mastery, attempts: row.attempts, mistakes: Object.fromEntries(Object.entries(row.mistakes).map(([m, n]) => [MISTAKE_LABEL[m as keyof typeof MISTAKE_LABEL], n])) } : null,
    },
    schema: ChapterSupplementOutputSchema,
    env: core.claudeEnv(),
    signal: ctx.signal,
    check: (d) => (d.markdown.trim().length < 20 ? 'markdown が短すぎます。補足として読める説明を書いてください。' : null),
  });

  // 追記分も、別の呼び出しで点検する(指摘があれば1回直す)
  const reviewed = await reviewAndRevise(
    core,
    {
      projectId,
      subjectName: subject.name,
      project,
      chapterTitle,
      target: 'supplement',
      sections: { supplement: sup.data.markdown.trim() },
      figures: [],
      examples: [],
      context: before.points,
    },
    ctx,
  );

  // 待っている間に章が作り直されていたら、そちらに足す(前の版は残す)
  ctx.progress('補足を章に追記しています');
  const current = getChapter(core, projectId, subjectId, unitId) ?? before;
  keepVersion(core, projectId, subjectId, current);
  const at = new Date().toISOString();
  const chapterVersion = current.chapterVersion + 1;
  writeChapter(
    core,
    projectId,
    subjectId,
    { ...current, chapterVersion, updatedAt: at, supplements: [...current.supplements, { at, chatId, title: sup.data.title.trim(), markdown: reviewed.sections.supplement ?? sup.data.markdown.trim() }] },
    no,
  );
  appendReviewRecord(core, projectId, subjectId, unitId, { at, chapterVersion, target: 'supplement', issues: reviewed.issues, comment: reviewed.comment, revised: reviewed.revised, verify: null });
  updateTocChapter(core, projectId, subjectId, unitId, { chapterVersion });
  return { unitId, chapterVersion, title: sup.data.title.trim(), issues: reviewed.issues.length, revised: reviewed.revised };
}

// ───────── まとめて作る ─────────

export interface BuildAllPlan {
  /** 未作成の章(章の順)。 */
  targets: Array<{ unitId: string; no: number; title: string }>;
  /** 1章あたりの呼び出しの目安と最大。 */
  perChapter: number;
  perChapterMax: number;
  /** 全部を作るときの呼び出しの見込み数。 */
  estimateCalls: number;
  maxCalls: number;
  /** 今日これまでの呼び出しの数と、1日の上限。 */
  used: number;
  limit: number;
  /** 今日作る章と、1日の上限のために翌日以降に回す章(単元 ID)。 */
  today: string[];
  later: string[];
}

/** 今日あと何章ぶん作れるか(1日の上限の残りから、すでに並んでいる章づくりの分を引く)。 */
export function chapterCapacityToday(core: AppCore): number {
  const limiter = core.limiter;
  const reserved = core.jobs.list().filter((j) => j.kind === CHAPTER_JOB_KIND && (j.status === 'queued' || j.status === 'running')).length * CHAPTER_CALLS_ESTIMATE;
  return Math.max(0, Math.floor((limiter.limit() - limiter.used() - reserved) / CHAPTER_CALLS_ESTIMATE));
}

/** 「まとめて作る」の見込み(始める前に見せて、確認を取る)。 */
export function planBuildAll(core: AppCore, projectId: string, subjectId: string): BuildAllPlan {
  const toc = syncToc(core, projectId, subjectId);
  const targets = toc.chapters
    .filter((c) => !c.orphan)
    .map((c, i) => ({ unitId: c.unitId, no: i + 1, title: c.title, status: c.status }))
    .filter((c) => c.status === 'none')
    .map(({ status: _s, ...rest }) => rest);
  const capacity = chapterCapacityToday(core);
  const limiter = core.limiter;
  return {
    targets,
    perChapter: CHAPTER_CALLS_ESTIMATE,
    perChapterMax: CHAPTER_CALLS_MAX,
    estimateCalls: targets.length * CHAPTER_CALLS_ESTIMATE,
    maxCalls: targets.length * CHAPTER_CALLS_MAX,
    used: limiter.used(),
    limit: limiter.limit(),
    today: targets.slice(0, capacity).map((t) => t.unitId),
    later: targets.slice(capacity).map((t) => t.unitId),
  };
}

function writeDeferred(core: AppCore, projectId: string, subjectId: string, deferred: string[], deferredAt: string | null): void {
  const tb = textbookPaths(core, projectId, subjectId);
  const toc = syncToc(core, projectId, subjectId);
  writeData(tb.tocJson, Files.toc, { ...toc, deferred, deferredAt: deferred.length ? deferredAt : null, updatedAt: new Date().toISOString() });
}

/** 後日に回す章を記録する(toc.json。アプリを閉じても残る)。 */
export function setDeferred(core: AppCore, projectId: string, subjectId: string, unitIds: string[]): void {
  writeDeferred(core, projectId, subjectId, [...new Set(unitIds)], todayString());
}

/** 1日の上限で止まった章を、後日に回す列の先頭に入れる。 */
export function deferChapter(core: AppCore, projectId: string, subjectId: string, unitId: string): void {
  const toc = syncToc(core, projectId, subjectId);
  if (!toc.chapters.some((c) => c.unitId === unitId && !c.orphan)) return;
  writeDeferred(core, projectId, subjectId, [unitId, ...toc.deferred.filter((id) => id !== unitId)], todayString());
}

/**
 * 後日に回した章のうち、今日作る分を取り出す(回した日より後の日で、1日の上限に余裕があるぶんだけ)。
 * 取り出した章は列から外す。残りは、また次の日に回す。
 */
export function takeDeferredForToday(core: AppCore, projectId: string, subjectId: string): string[] {
  const toc = syncToc(core, projectId, subjectId);
  const today = todayString();
  if (toc.deferred.length === 0 || !toc.deferredAt || toc.deferredAt >= today) return [];
  const capacity = chapterCapacityToday(core);
  if (capacity === 0) return [];
  const take = toc.deferred.slice(0, capacity);
  writeDeferred(core, projectId, subjectId, toc.deferred.slice(capacity), today);
  return take;
}
