// 学習計画: 試験日・苦手マップ・傾向・1日の時間から、週ごとの計画を Claude が作る。遅れたら作り直す。
import { existsSync } from 'node:fs';
import { addDays, daysBetween, splitWeeks, todayString, type WeekRange } from '../shared/dates';
import { FORMAT_VERSION, MISTAKE_LABEL, PlanOutputSchema, type Plan, type PlanWeek, type Project } from '../shared/schema';
import { leafUnits } from '../shared/subjects';
import type { AppCore } from './app';
import { callClaude } from './claude/task';
import type { JobContext } from './jobs';
import { getProject } from './projects';
import { Files, readData, writeData } from './store';
import { listTests } from './tests';
import { getUnits, projectBrief } from './units';
import { dominantMistake, getWeaknessView, TARGET_MASTERY } from './weakness';

/** 一度に計画する週の数の上限(暫定)。それより先は、近づいてから作り直す。 */
export const PLAN_HORIZON_WEEKS = 26;
/** 直近この日数のうち、課題をやらなかった日がこの数以上なら「遅れ」とみなして作り直しを提案する(暫定)。 */
export const LATE_WINDOW_DAYS = 7;
export const LATE_MISSED_DAYS = 3;

/** 試験日と今日の関係。計画を作れるのは「試験が明日以降」のときだけ。 */
export function examState(today: string, examDate: string): 'past' | 'today' | 'future' {
  const n = daysBetween(today, examDate);
  return n < 0 ? 'past' : n === 0 ? 'today' : 'future';
}

/**
 * 通しの模擬試験の予定(暫定): 試験の前の週の1つ前(2週前)と、その2週前(4週前)に、科目ごとに1回ずつ。
 * 試験までが短いときは、入るところにだけ入れる。週の中で、科目ごとに日をずらす。
 */
export function scheduleMocks(weeks: WeekRange[], subjectIds: string[]): Array<{ date: string; subjectId: string; testId: null; weekIndex: number }> {
  const out: Array<{ date: string; subjectId: string; testId: null; weekIndex: number }> = [];
  const n = weeks.length;
  const targets = [n - 2, n - 4].filter((i) => i >= 0);
  for (const i of [...new Set(targets)].sort((a, b) => a - b)) {
    const w = weeks[i];
    const days = daysBetween(w.start, w.end) + 1;
    subjectIds.forEach((subjectId, k) => {
      out.push({ date: addDays(w.start, Math.min(days - 1, (k * 2 + 1) % Math.max(1, days))), subjectId, testId: null, weekIndex: w.index });
    });
  }
  return out;
}

export function getPlan(core: AppCore, projectId: string): Plan | null {
  const f = core.paths(projectId).planJson;
  return existsSync(f) ? readData(f, Files.plan) : null;
}

/** 日ごとに、採点まで済んだ「今日の課題」があったか。 */
export function activeDays(core: AppCore, project: Project): Set<string> {
  const days = new Set<string>();
  for (const s of project.subjects) {
    for (const t of listTests(core, project.id, s.id)) {
      if (t.kind === 'daily' && t.date && t.status === 'graded') days.add(t.date);
    }
  }
  return days;
}

export interface PlanView {
  plan: Plan | null;
  today: string;
  exam: 'past' | 'today' | 'future';
  /** 今日が入っている週(計画の範囲の外なら null)。 */
  currentWeek: number | null;
  /** 直近の、課題をやれた日・やれなかった日(計画を作った日から昨日まで、最大7日)。 */
  progress: { doneDays: number; missedDays: number };
  /** 遅れているので、作り直しを提案する。 */
  late: boolean;
  /** 計画の範囲が終わった・試験日や科目が変わった、などで作り直しが要る。 */
  outdated: string | null;
}

export function progressOf(plan: Plan, today: string, active: Set<string>): { doneDays: number; missedDays: number } {
  let doneDays = 0;
  let missedDays = 0;
  for (let i = 1; i <= LATE_WINDOW_DAYS; i++) {
    const d = addDays(today, -i);
    if (daysBetween(plan.startDate, d) < 0) break;
    if (active.has(d)) doneDays++;
    else missedDays++;
  }
  return { doneDays, missedDays };
}

export function getPlanView(core: AppCore, projectId: string): PlanView {
  const project = getProject(core, projectId);
  const plan = getPlan(core, projectId);
  const today = todayString();
  const exam = examState(today, project.examDate);
  if (!plan) return { plan, today, exam, currentWeek: null, progress: { doneDays: 0, missedDays: 0 }, late: false, outdated: null };
  const current = plan.weeks.find((w) => daysBetween(w.start, today) >= 0 && daysBetween(today, w.end) >= 0);
  const progress = progressOf(plan, today, activeDays(core, project));
  let outdated: string | null = null;
  const planned = new Set(plan.weeks.flatMap((w) => w.items.map((i) => i.subjectId)));
  if (plan.examDate !== project.examDate) outdated = '試験日が変わりました。';
  else if (plan.dailyMinutes !== project.dailyMinutes) outdated = '1日に使える時間が変わりました。';
  else if (project.subjects.some((s) => !planned.has(s.id))) outdated = '科目が増えました。';
  else if (!current && exam === 'future') outdated = '計画した期間が終わりました。';
  return { plan, today, exam, currentWeek: current?.index ?? null, progress, late: exam === 'future' && progress.missedDays >= LATE_MISSED_DAYS, outdated: exam === 'future' ? outdated : null };
}

/** 学習計画を作る(すでにあれば作り直す)。 */
export async function createPlan(core: AppCore, projectId: string, reason: string, ctx: JobContext): Promise<Plan> {
  const project = getProject(core, projectId);
  const today = todayString();
  const exam = examState(today, project.examDate);
  if (exam === 'past') throw new Error('試験日を過ぎています。プロジェクトの「設定を変える」で、次の試験日を入れてください。');
  if (exam === 'today') throw new Error('今日が試験日です。新しい計画は作りません。落ち着いて、これまでの復習を見直しましょう。');
  const weeks = splitWeeks(today, project.examDate, PLAN_HORIZON_WEEKS);
  const beyond = daysBetween(weeks[weeks.length - 1].end, addDays(project.examDate, -1)) > 0;
  const mocks = beyond
    ? []
    : scheduleMocks(
        weeks,
        project.subjects.map((s) => s.id),
      );
  const mockWeeks = new Set(mocks.map((m) => m.weekIndex));
  const previous = getPlan(core, projectId);
  const target = TARGET_MASTERY[project.targetLevel];

  const subjects = project.subjects.map((s) => {
    const w = getWeaknessView(core, projectId, s.id);
    const sp = core.paths(projectId).subject(s.id);
    const trend = existsSync(sp.trendJson) ? readData(sp.trendJson, Files.trend) : null;
    return {
      id: s.id,
      name: s.name,
      mastery: w.overall,
      targetMastery: target,
      weakUnits: w.rows.slice(0, 8).map((r) => ({ unitId: r.unitId, unitName: r.unitName, mastery: r.mastery, mistake: dominantMistake(r) ? MISTAKE_LABEL[dominantMistake(r)!] : null })),
      untestedUnits: w.untested,
      units: leafUnits(getUnits(core, projectId, s.id).tree).map((u) => ({ id: u.id, name: u.fullName, weight: u.weight })),
      trend: trend ? { format: trend.format, frequentUnits: trend.frequentUnits, difficulty: trend.difficulty } : null,
    };
  });
  const unitIds = new Map(subjects.map((s) => [s.id, new Set(s.units.map((u) => u.id))]));
  const progress = previous ? { ...progressOf(previous, today, activeDays(core, project)), reason: reason || '計画の見直し', previousAdvice: previous.advice.slice(0, 600) } : null;

  ctx.progress(`Claude が ${weeks.length} 週ぶんの学習計画を作っています`);
  const r = await callClaude({
    projectDir: core.projectDir(projectId),
    kind: 'plan',
    vars: { revisionNote: previous ? `これは **作り直し** です(理由: ${reason || '計画の見直し'})。` : 'これが最初の計画です。' },
    input: {
      project: projectBrief(project),
      today,
      dailyMinutes: project.dailyMinutes,
      weeks: weeks.map((w) => ({ index: w.index, start: w.start, end: w.end, days: daysBetween(w.start, w.end) + 1, mock: mockWeeks.has(w.index) })),
      beyond,
      subjects,
      progress,
    },
    schema: PlanOutputSchema,
    env: core.claudeEnv(),
    signal: ctx.signal,
    check: (d) => {
      if (d.weeks.length !== weeks.length) return `weeks の数が違います(入力は ${weeks.length} 週、出力は ${d.weeks.length} 週)。入力の weeks と同じ数・同じ順で書いてください。`;
      const bad = d.weeks.flatMap((w) => w.items).find((i) => !unitIds.has(i.subjectId));
      return bad ? `subjectId「${bad.subjectId}」は、入力の subjects にありません。` : null;
    },
  });

  const kept = (previous?.mocks ?? []).filter((m) => m.testId);
  const planWeeks: PlanWeek[] = weeks.map((w, i) => ({
    index: w.index,
    start: w.start,
    end: w.end,
    mock: mockWeeks.has(w.index),
    theme: r.data.weeks[i].theme,
    // 一覧に無い単元は捨てる。時間は 0 以上の整数にする
    items: r.data.weeks[i].items.map((it) => ({ ...it, unitIds: it.unitIds.filter((u) => unitIds.get(it.subjectId)!.has(u)), minutes: Math.max(0, Math.round(it.minutes)) })),
  }));
  return writeData(core.paths(projectId).planJson, Files.plan, {
    version: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    startDate: today,
    examDate: project.examDate,
    dailyMinutes: project.dailyMinutes,
    weeks: planWeeks,
    // すでに作った模擬試験の予定は残し、近い日の新しい予定とは重ねない
    mocks: [
      ...kept,
      ...mocks.filter((m) => !kept.some((k) => k.subjectId === m.subjectId && Math.abs(daysBetween(k.date, m.date)) < 7)).map((m) => ({ date: m.date, subjectId: m.subjectId, testId: null })),
    ].sort((a, b) => a.date.localeCompare(b.date)),
    advice: r.data.advice,
    revision: previous ? previous.revision + 1 : 0,
    reason: previous ? reason || '計画の見直し' : '',
  });
}
