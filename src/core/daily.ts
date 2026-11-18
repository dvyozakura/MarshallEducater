// 今日の課題: 苦手克服問題・過去問の類題・復習(間をあけた再出題)を、科目ごとに1日1つのテストとして作る。
// 毎日その日の時点の計画・苦手マップ・復習の期限から作るので、やらなかった日があっても積み残さない。
import { existsSync } from 'node:fs';
import { addDays, daysBetween, todayString } from '../shared/dates';
import { FORMAT_VERSION, type Difficulty, type ExamType, type Grading, type Plan, type ProblemFormat, type Project, type Review, type ReviewItem, type Test } from '../shared/schema';
import { leafUnits } from '../shared/subjects';
import type { AppCore } from './app';
import { createDesignedTest } from './diagnostic';
import type { ProblemRequest } from './generate';
import { effectiveScore } from './grading';
import type { JobContext } from './jobs';
import { getPlan } from './plan';
import { getProject, getSubject } from './projects';
import { Files, readData, readDataOr, writeData } from './store';
import { createTest, listTests } from './tests';
import { getUnits } from './units';
import { dominantMistake, getWeaknessView } from './weakness';

// ───── 数値はどれも暫定(DECISIONS.md に記録) ─────
/** 1科目の課題にかける時間の目安(分)。1日に扱う科目の数を決めるのに使う。 */
export const MINUTES_PER_SUBJECT = 45;
export const MAX_SUBJECTS_PER_DAY = 3;
/** 1問あたりの時間の目安(分)と、1つの課題の問題数の範囲。 */
export const MINUTES_PER_PROBLEM = 8;
export const DAILY_PROBLEMS = { min: 3, max: 8 };
/** 復習の間隔(日)。正解するたびに次へ進み、最後まで正解したら復習を終える。間違えたら最初に戻る。 */
export const REVIEW_INTERVALS = [2, 5, 12, 30];
/** 予定日を過ぎた模擬試験を、何日後まで「今日の課題」に出すか。 */
export const MOCK_GRACE_DAYS = 6;

// ───── 復習の予定(review.json) ─────

function emptyReview(): Review {
  return { version: FORMAT_VERSION, items: [] };
}

export function getReview(core: AppCore, projectId: string, subjectId: string): Review {
  return readDataOr(core.paths(projectId).subject(subjectId).reviewJson, Files.review, emptyReview);
}

/**
 * 採点結果を、復習の予定に反映する。
 * - ふつうの問題を間違えた → 2日後に類題を出す予定を足す(上書きで満点になったら取り消す)。
 * - 復習の問題に正解した → 間隔を延ばす(2 → 5 → 12 → 30 日)。最後まで正解したら終える。間違えたら 2 日後からやり直す。
 */
export function applyGradingToReview(review: Review, test: Test, grading: Grading, today: string): Review {
  let items = review.items.slice();
  for (const g of grading.items) {
    const p = test.problems.find((q) => q.id === g.problemId);
    if (!p) continue;
    const full = g.max > 0 && effectiveScore(g) >= g.max;
    if (p.reviewOf) {
      const i = items.findIndex((it) => it.testId === p.reviewOf!.testId && it.problemId === p.reviewOf!.problemId);
      // 同じテストの採点を二重に数えない(上書きのあとにも呼ばれるため。復習の結果は最初の採点で決める)
      if (i < 0 || items[i].lastReviewedBy === test.id) continue;
      const it = items[i];
      if (full) {
        const step = REVIEW_INTERVALS.indexOf(it.intervalDays) + 1;
        if (step >= REVIEW_INTERVALS.length) items.splice(i, 1);
        else items[i] = { ...it, streak: it.streak + 1, intervalDays: REVIEW_INTERVALS[step], due: addDays(today, REVIEW_INTERVALS[step]), lastReviewedBy: test.id };
      } else {
        items[i] = { ...it, streak: 0, intervalDays: REVIEW_INTERVALS[0], due: addDays(today, REVIEW_INTERVALS[0]), lastReviewedBy: test.id };
      }
      continue;
    }
    const i = items.findIndex((it) => it.testId === test.id && it.problemId === p.id);
    if (!full && i < 0) {
      items.push({ testId: test.id, problemId: p.id, unitId: p.unitId, unitName: p.unitName, difficulty: p.difficulty, format: p.format, body: p.body, due: addDays(today, REVIEW_INTERVALS[0]), intervalDays: REVIEW_INTERVALS[0], streak: 0, lastReviewedBy: null });
    } else if (full && i >= 0 && items[i].lastReviewedBy === null) {
      items = items.filter((_x, n) => n !== i); // 上書きで満点になった → 復習は要らない
    }
  }
  return { version: FORMAT_VERSION, items };
}

/** 採点(と上書き)のあとに呼ばれる。 */
export function updateReviewFromGrading(core: AppCore, projectId: string, subjectId: string, test: Test, grading: Grading): void {
  const file = core.paths(projectId).subject(subjectId).reviewJson;
  writeData(file, Files.review, applyGradingToReview(getReview(core, projectId, subjectId), test, grading, todayString()));
}

export function dueReviews(review: Review, today: string): ReviewItem[] {
  return review.items.filter((it) => daysBetween(it.due, today) >= 0).sort((a, b) => a.due.localeCompare(b.due));
}

// ───── 今日あつかう科目 ─────

/** 今日あつかう科目(計画の今週の時間が多い順に並べ、日ごとに順番に回す)。 */
export function subjectsForDay(project: Project, plan: Plan | null, today: string): Array<{ subjectId: string; minutes: number }> {
  const count = Math.max(1, Math.min(MAX_SUBJECTS_PER_DAY, project.subjects.length, Math.round(project.dailyMinutes / MINUTES_PER_SUBJECT)));
  const week = plan?.weeks.find((w) => daysBetween(w.start, today) >= 0 && daysBetween(today, w.end) >= 0);
  const weekMinutes = new Map((week?.items ?? []).map((i) => [i.subjectId, i.minutes]));
  // 計画に入っていない科目(あとから足した科目・計画なし)も、少ない時間で回す
  const ordered = project.subjects
    .map((s, i) => ({ subjectId: s.id, weight: weekMinutes.get(s.id) ?? (week ? 0 : 1), i }))
    .filter((s) => !week || s.weight > 0 || !weekMinutes.size)
    .sort((a, b) => b.weight - a.weight || a.i - b.i);
  const list = ordered.length ? ordered : project.subjects.map((s, i) => ({ subjectId: s.id, weight: 1, i }));
  const day = Math.max(0, daysBetween(plan?.startDate ?? '2026-01-01', today));
  const picked: string[] = [];
  for (let k = 0; k < Math.min(count, list.length); k++) picked.push(list[(day * count + k) % list.length].subjectId);
  const minutes = Math.round(project.dailyMinutes / picked.length);
  return picked.map((subjectId) => ({ subjectId, minutes }));
}

// ───── 課題の中身 ─────

function formatFor(examType: ExamType, n: number): ProblemFormat {
  if (examType === 'kyotsu') return 'choice';
  if (examType === 'kokkoritsu') return (['short', 'essay'] as const)[n % 2];
  return (['choice', 'short'] as const)[n % 2];
}

function difficultyFor(mastery: number | null): Difficulty {
  if (mastery === null) return 'standard';
  return mastery < 40 ? 'easy' : mastery < 70 ? 'standard' : 'target';
}

export interface DailyInputs {
  examType: ExamType;
  minutes: number;
  /** 出題の対象の単元(重みつき)。 */
  units: Array<{ id: string; name: string; weight: number }>;
  /** 計画の今週、この科目で取り組む単元。 */
  planUnitIds: string[];
  /** 弱い順。 */
  weak: Array<{ unitId: string; mastery: number; mistake: ProblemRequest['mistake'] }>;
  /** 傾向の頻出単元(単元の名前)。傾向が無ければ null。 */
  trendUnits: string[] | null;
  dueReviews: ReviewItem[];
}

/** 1科目・1日ぶんの課題の注文を組み立てる: 復習 → 過去問の類題 → 苦手克服問題。 */
export function buildDailyRequests(d: DailyInputs): ProblemRequest[] {
  const total = Math.max(DAILY_PROBLEMS.min, Math.min(DAILY_PROBLEMS.max, Math.round(d.minutes / MINUTES_PER_PROBLEM)));
  const out: ProblemRequest[] = [];
  const unitIds = new Set(d.units.map((u) => u.id));
  const used = new Set<string>();

  // 復習: 期限が来たもの(全体の3分の1まで。古い順)。形式・難易度はもとの問題に合わせる
  for (const r of d.dueReviews.slice(0, Math.max(1, Math.floor(total / 3)))) {
    out.push({ unitId: r.unitId, difficulty: r.difficulty, format: r.format, origin: 'review', reference: r.body, reviewOf: { testId: r.testId, problemId: r.problemId } });
    used.add(r.unitId);
  }

  // 過去問の類題: 傾向があるときだけ(全体の3分の1まで)。頻出単元を、志望校の水準で
  if (d.trendUnits) {
    const frequent = d.trendUnits
      .map((name) => d.units.find((u) => u.name === name) ?? d.units.find((u) => u.name.endsWith(name) || name.endsWith(u.name.split(' > ').pop() ?? '\u0000')))
      .filter((u): u is DailyInputs['units'][number] => !!u);
    const pool = frequent.length ? frequent : d.units.filter((u) => d.planUnitIds.includes(u.id));
    const n = Math.min(pool.length, Math.max(1, Math.floor(total / 3)), total - out.length);
    for (let i = 0; i < n; i++) {
      const u = pool[i % pool.length];
      const mastery = d.weak.find((w) => w.unitId === u.id)?.mastery ?? null;
      out.push({ unitId: u.id, difficulty: mastery !== null && mastery < 40 ? 'standard' : 'target', format: formatFor(d.examType, out.length), origin: 'similar' });
      used.add(u.id);
    }
  }

  // 苦手克服問題: 弱い単元(計画の今週の単元を先に)。記録が無いうちは、計画の単元・重みの大きい単元から
  const weak = d.weak.filter((w) => unitIds.has(w.unitId) && w.mastery < 70);
  const ordered = [...weak.filter((w) => d.planUnitIds.includes(w.unitId)), ...weak.filter((w) => !d.planUnitIds.includes(w.unitId))];
  const fallback = [...d.units.filter((u) => d.planUnitIds.includes(u.id)), ...[...d.units].sort((a, b) => b.weight - a.weight)].map((u) => ({ unitId: u.id, mastery: null as number | null, mistake: null }));
  const candidates = [...ordered.map((w) => ({ ...w, mastery: w.mastery as number | null })), ...fallback];
  const seen = new Set<string>();
  const queue = candidates.filter((c) => (seen.has(c.unitId) ? false : (seen.add(c.unitId), true)));
  // まだ使っていない単元を先に。足りなければ同じ単元からもう1問
  const fresh = queue.filter((c) => !used.has(c.unitId));
  const pick = fresh.length ? [...fresh, ...queue.filter((c) => used.has(c.unitId))] : queue;
  for (let i = 0; out.length < total && pick.length > 0; i++) {
    const c = pick[i % pick.length];
    out.push({ unitId: c.unitId, difficulty: difficultyFor(c.mastery), format: formatFor(d.examType, out.length), origin: c.mastery === null ? 'practice' : 'weakness', mistake: c.mistake ?? null });
  }
  return out;
}

function dailyInputs(core: AppCore, project: Project, subjectId: string, minutes: number, today: string): DailyInputs {
  const sp = core.paths(project.id).subject(subjectId);
  const plan = getPlan(core, project.id);
  const week = plan?.weeks.find((w) => daysBetween(w.start, today) >= 0 && daysBetween(today, w.end) >= 0);
  const trend = existsSync(sp.trendJson) ? readData(sp.trendJson, Files.trend) : null;
  const weakness = getWeaknessView(core, project.id, subjectId);
  return {
    examType: project.examType,
    minutes,
    units: leafUnits(getUnits(core, project.id, subjectId).tree).map((u) => ({ id: u.id, name: u.fullName, weight: u.weight })),
    planUnitIds: week?.items.find((i) => i.subjectId === subjectId)?.unitIds ?? [],
    weak: weakness.rows.map((r) => ({ unitId: r.unitId, mastery: r.mastery, mistake: dominantMistake(r) })),
    trendUnits: trend ? trend.frequentUnits.map((u) => u.unit) : null,
    dueReviews: dueReviews(getReview(core, project.id, subjectId), today),
  };
}

export function findDaily(core: AppCore, projectId: string, subjectId: string, date: string): Test | null {
  return listTests(core, projectId, subjectId).find((t) => t.kind === 'daily' && t.date === date) ?? null;
}

/** 1科目の、今日の課題を作る。もうあれば、それを返す(1日に1つ)。 */
export async function createDaily(core: AppCore, projectId: string, subjectId: string, ctx: JobContext): Promise<Test> {
  const project = getProject(core, projectId);
  const subject = getSubject(project, subjectId);
  const today = todayString();
  const existing = findDaily(core, projectId, subjectId, today);
  if (existing) return existing;
  const minutes = subjectsForDay(project, getPlan(core, projectId), today).find((s) => s.subjectId === subjectId)?.minutes ?? Math.min(project.dailyMinutes, MINUTES_PER_SUBJECT);
  const requests = buildDailyRequests(dailyInputs(core, project, subjectId, minutes, today));
  if (requests.length === 0) throw new Error('出題できる単元がありません。科目の「単元」で、重みが 0 でない単元を残してください。');
  const [, m, d] = today.split('-').map(Number);
  return createTest(
    core,
    projectId,
    subjectId,
    {
      kind: 'daily',
      title: `${subject.name} ${m}月${d}日の課題`,
      timeLimitMin: Math.max(10, requests.length * MINUTES_PER_PROBLEM),
      instructions: '今日の課題です。苦手克服問題・過去問の類題・復習が入っています。解き終えたら提出して、解説を読みましょう。',
      purpose: '今日の課題(苦手克服・過去問の類題・復習)',
      requests,
      date: today,
    },
    ctx,
  );
}

/** 予定の日が来た(過ぎて間もない)、まだ作っていない模擬試験。 */
export function dueMocks(plan: Plan | null, today: string): Array<{ date: string; subjectId: string }> {
  return (plan?.mocks ?? []).filter((m) => !m.testId && daysBetween(m.date, today) >= 0 && daysBetween(m.date, today) <= MOCK_GRACE_DAYS);
}

/** 予定されていた通しの模擬試験を作り、計画に結び付ける。 */
export async function createScheduledMock(core: AppCore, projectId: string, subjectId: string, ctx: JobContext): Promise<Test> {
  const today = todayString();
  const due = dueMocks(getPlan(core, projectId), today).find((m) => m.subjectId === subjectId);
  if (!due) throw new Error('この科目には、いま受ける予定の模擬試験がありません。');
  const test = await createDesignedTest(core, projectId, subjectId, 'mock', ctx, today);
  // 作っている間に計画が作り直されているかもしれないので、読み直してから書く
  const plan = getPlan(core, projectId);
  if (plan) {
    const i = plan.mocks.findIndex((m) => !m.testId && m.subjectId === subjectId && m.date === due.date);
    if (i >= 0) writeData(core.paths(projectId).planJson, Files.plan, { ...plan, mocks: plan.mocks.map((m, n) => (n === i ? { ...m, testId: test.id } : m)) });
  }
  return test;
}

export interface TodayView {
  date: string;
  hasPlan: boolean;
  /** 今日あつかう科目と、その課題(まだ作っていなければ null)。 */
  subjects: Array<{ subjectId: string; name: string; minutes: number; test: Test | null; dueReviews: number }>;
  /** 今日受ける通しの模擬試験(作成済みのものは test に入る)。 */
  mocks: Array<{ subjectId: string; name: string; date: string; test: Test | null }>;
}

export function getTodayView(core: AppCore, projectId: string): TodayView {
  const project = getProject(core, projectId);
  const plan = getPlan(core, projectId);
  const today = todayString();
  const name = (id: string) => project.subjects.find((s) => s.id === id)?.name ?? id;
  const exists = (id: string) => project.subjects.some((s) => s.id === id);
  const subjects = subjectsForDay(project, plan, today).map((s) => ({
    ...s,
    name: name(s.subjectId),
    test: findDaily(core, projectId, s.subjectId, today),
    dueReviews: dueReviews(getReview(core, projectId, s.subjectId), today).length,
  }));
  // 予定の日が来た模擬試験(未作成)と、今日作った模擬試験
  const mocks = [
    ...dueMocks(plan, today)
      .filter((m) => exists(m.subjectId))
      .map((m) => ({ subjectId: m.subjectId, name: name(m.subjectId), date: m.date, test: null as Test | null })),
    ...project.subjects.flatMap((s) =>
      listTests(core, projectId, s.id)
        .filter((t) => t.kind === 'mock' && t.status !== 'graded' && (plan?.mocks ?? []).some((m) => m.testId === t.id))
        .map((t) => ({ subjectId: s.id, name: s.name, date: t.date ?? today, test: t as Test | null })),
    ),
  ];
  return { date: today, hasPlan: !!plan, subjects, mocks };
}
