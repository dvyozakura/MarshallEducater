import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyGradingToReview, buildDailyRequests, dueMocks, dueReviews, REVIEW_INTERVALS, subjectsForDay, type DailyInputs } from '../../src/core/daily';
import { addDays } from '../../src/shared/dates';
import type { Grading, Plan, Project, Review, Test } from '../../src/shared/schema';
import { done, importFake, settled, setupTest, submitAndGrade } from './helpers';

const TODAY = '2026-11-17';
beforeEach(() => {
  process.env.ME_TODAY = TODAY;
});
afterEach(() => {
  delete process.env.ME_TODAY;
});

const units = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `u${n}`, name: `親 > 単元${n}`, weight: n === 6 ? 3 : 1 }));
const base: DailyInputs = { examType: 'kokkoritsu', minutes: 48, units, planUnitIds: ['u3'], weak: [], trendUnits: null, dueReviews: [] };

describe('課題の中身(苦手克服問題・過去問の類題・復習)', () => {
  it('苦手マップが無いうちは、計画の単元と重みの大きい単元から「演習」として出す', () => {
    const r = buildDailyRequests(base);
    expect(r).toHaveLength(6); // 48分 ÷ 8分
    expect(r[0]).toMatchObject({ unitId: 'u3', origin: 'practice', difficulty: 'standard' });
    expect(r[1].unitId).toBe('u6');
    expect(new Set(r.map((x) => x.format))).toEqual(new Set(['short', 'essay']));
    expect(buildDailyRequests({ ...base, minutes: 5 })).toHaveLength(3);
    expect(buildDailyRequests({ ...base, minutes: 600 })).toHaveLength(8);
    expect(buildDailyRequests({ ...base, examType: 'kyotsu' }).every((x) => x.format === 'choice')).toBe(true);
  });

  it('弱い単元は、習熟度に合った難しさで、よくするミスを添えて出す。計画の今週の単元が先', () => {
    const r = buildDailyRequests({
      ...base,
      weak: [
        { unitId: 'u1', mastery: 20, mistake: 'calculation' },
        { unitId: 'u3', mastery: 55, mistake: 'approach' },
        { unitId: 'u5', mastery: 90, mistake: null },
      ],
    });
    expect(r[0]).toMatchObject({ unitId: 'u3', origin: 'weakness', difficulty: 'standard', mistake: 'approach' });
    expect(r[1]).toMatchObject({ unitId: 'u1', origin: 'weakness', difficulty: 'easy', mistake: 'calculation' });
    expect(r.filter((x) => x.unitId === 'u5' && x.origin === 'weakness')).toHaveLength(0); // できている単元は苦手克服に入れない
  });

  it('期限の来た復習と、傾向の頻出単元の類題が入る。残りが苦手克服', () => {
    const review = (n: number) => ({ testId: 't0', problemId: `p${n}`, unitId: 'u2', unitName: '単元2', difficulty: 'easy' as const, format: 'choice' as const, body: `もとの問題${n}`, due: TODAY, intervalDays: 2, streak: 0, lastReviewedBy: null });
    const r = buildDailyRequests({ ...base, trendUnits: ['親 > 単元4', '単元5', '無い単元'], weak: [{ unitId: 'u1', mastery: 20, mistake: 'knowledge' }], dueReviews: [review(1), review(2), review(3)] });
    expect(r).toHaveLength(6);
    expect(r.filter((x) => x.origin === 'review')).toHaveLength(2); // 全体の3分の1まで
    expect(r[0]).toMatchObject({ origin: 'review', unitId: 'u2', format: 'choice', difficulty: 'easy', reference: 'もとの問題1', reviewOf: { testId: 't0', problemId: 'p1' } });
    const similar = r.filter((x) => x.origin === 'similar');
    expect(similar.map((x) => x.unitId)).toEqual(['u4', 'u5']);
    expect(similar.every((x) => x.difficulty === 'target')).toBe(true);
    expect(r.filter((x) => x.origin === 'weakness')[0]).toMatchObject({ unitId: 'u1', difficulty: 'easy', mistake: 'knowledge' });
  });
});

describe('今日あつかう科目', () => {
  const project = { subjects: ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id })), dailyMinutes: 90 } as Project;
  const plan = { startDate: TODAY, weeks: [{ index: 0, start: TODAY, end: addDays(TODAY, 6), items: [{ subjectId: 'a', minutes: 100 }, { subjectId: 'b', minutes: 300 }, { subjectId: 'c', minutes: 200 }, { subjectId: 'd', minutes: 0 }] }] } as unknown as Plan;

  it('計画の時間が多い科目から、日ごとに順番に回す。時間 0 の科目は出さない', () => {
    expect(subjectsForDay(project, plan, TODAY)).toEqual([{ subjectId: 'b', minutes: 45 }, { subjectId: 'c', minutes: 45 }]);
    expect(subjectsForDay(project, plan, addDays(TODAY, 1)).map((s) => s.subjectId)).toEqual(['a', 'b']);
    expect(subjectsForDay(project, plan, addDays(TODAY, 2)).map((s) => s.subjectId)).toEqual(['c', 'a']);
    const week = [0, 1, 2, 3, 4, 5].flatMap((d) => subjectsForDay(project, plan, addDays(TODAY, d)).map((s) => s.subjectId));
    expect(new Set(week)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('計画が無くても、計画の範囲の外の日でも、科目を回せる', () => {
    expect(subjectsForDay(project, null, TODAY)).toHaveLength(2);
    expect(subjectsForDay(project, plan, addDays(TODAY, 30))).toHaveLength(2);
    expect(subjectsForDay({ ...project, dailyMinutes: 20 } as Project, null, TODAY)).toHaveLength(1);
    expect(subjectsForDay({ ...project, dailyMinutes: 600 } as Project, null, TODAY)).toHaveLength(3);
  });
});

describe('復習(間をあけた再出題)', () => {
  const problem = (id: string, reviewOf: Test['problems'][number]['reviewOf'] = null) => ({ id, number: id, unitId: 'u1', unitName: '単元1', difficulty: 'standard', format: 'short', body: `本文 ${id}`, choices: [], points: 10, figureSvg: null, origin: 'weakness', reviewOf }) as Test['problems'][number];
  const grading = (testId: string, scores: Record<string, number>): Grading => ({
    version: 1,
    testId,
    gradedAt: '',
    overrides: [],
    items: Object.entries(scores).map(([problemId, score]) => ({ problemId, score, max: 10, rationale: '', mistake: null, comment: '', unitId: 'u1', unitName: '単元1', difficulty: 'standard', override: null })),
  });
  const empty: Review = { version: 1, items: [] };

  it('間違えた問題は2日後に。正解するたびに間隔が延び、最後まで正解したら終わる。間違えたら最初から', () => {
    const t1 = { id: 't1', problems: [problem('p1'), problem('p2')] } as Test;
    let r = applyGradingToReview(empty, t1, grading('t1', { p1: 0, p2: 10 }), TODAY);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ testId: 't1', problemId: 'p1', due: addDays(TODAY, 2), intervalDays: 2, streak: 0, body: '本文 p1' });
    expect(dueReviews(r, addDays(TODAY, 1))).toHaveLength(0); // 日をまたいでも、期限までは出ない
    expect(dueReviews(r, addDays(TODAY, 2))).toHaveLength(1);
    expect(dueReviews(r, addDays(TODAY, 9))).toHaveLength(1); // やらなかった日があっても、残っている

    let day = addDays(TODAY, 2);
    REVIEW_INTERVALS.slice(1).forEach((interval, i) => {
      const tn = { id: `r${i}`, problems: [problem('q1', { testId: 't1', problemId: 'p1' })] } as Test;
      r = applyGradingToReview(r, tn, grading(tn.id, { q1: 10 }), day);
      expect(r.items[0]).toMatchObject({ intervalDays: interval, streak: i + 1, due: addDays(day, interval), lastReviewedBy: tn.id });
      // 同じテストを反映し直しても(上書き)、二重には進まない
      expect(applyGradingToReview(r, tn, grading(tn.id, { q1: 10 }), day)).toEqual(r);
      day = addDays(day, interval);
    });
    // 途中で間違えたら 2 日後からやり直し(復習の問題そのものは、新しい復習を増やさない)
    const miss = { id: 'rx', problems: [problem('q1', { testId: 't1', problemId: 'p1' })] } as Test;
    const back = applyGradingToReview(r, miss, grading('rx', { q1: 3 }), day);
    expect(back.items).toHaveLength(1);
    expect(back.items[0]).toMatchObject({ intervalDays: 2, streak: 0, due: addDays(day, 2) });
    // 最後の間隔でも正解 → 復習を終える
    const last = { id: 'rz', problems: [problem('q1', { testId: 't1', problemId: 'p1' })] } as Test;
    expect(applyGradingToReview(r, last, grading('rz', { q1: 10 }), day).items).toHaveLength(0);
  });

  it('上書きで満点になったら、復習の予定を取り消す', () => {
    const t1 = { id: 't1', problems: [problem('p1')] } as Test;
    const r = applyGradingToReview(empty, t1, grading('t1', { p1: 0 }), TODAY);
    const g = grading('t1', { p1: 0 });
    g.items[0].override = { score: 10, note: '', at: '' };
    expect(applyGradingToReview(r, t1, g, TODAY).items).toHaveLength(0);
    expect(applyGradingToReview(r, t1, grading('t1', { p1: 0 }), addDays(TODAY, 1))).toEqual(r);
  });
});

describe('今日の課題(偽 Claude での一連の流れ・日をまたぐ動作)', () => {
  it('診断の結果から今日の課題を作る → 解く → 採点 → 苦手マップ更新。翌々日には復習が入る', async () => {
    const { t, p, sid, ids } = await setupTest();
    await submitAndGrade(t, ids, { p01: '2', p02: '99', p03: '位ごとに足すと 26' }); // p02 誤答、p04 未解答
    expect(t.api.getReview(p.id, sid).items.map((i) => i.problemId)).toEqual(['p02', 'p04']);
    await done(t, t.api.startCreatePlan(p.id));

    const today = t.api.getTodayView(p.id);
    expect(today).toMatchObject({ date: TODAY, hasPlan: true });
    expect(today.subjects.map((s) => s.test)).toEqual([null, null]);
    const jobs = t.api.startCreateToday(p.id);
    expect(jobs).toHaveLength(2);
    for (const j of jobs) await done(t, j);
    expect(t.api.startCreateToday(p.id)).toHaveLength(0); // 1日に1つ。もう一度押しても増えない

    const daily = t.api.getTodayView(p.id).subjects.find((s) => s.subjectId === sid)!.test!;
    expect(daily).toMatchObject({ kind: 'daily', date: TODAY, title: '数学II・B・C 11月17日の課題', status: 'ready' });
    expect(daily.problems.length).toBeGreaterThanOrEqual(3);
    // 1日目: 復習はまだ期限前。弱い単元の苦手克服問題が入る
    expect(daily.problems.some((q) => q.origin === 'review')).toBe(false);
    expect(daily.problems[0].origin).toBe('weakness');
    const weakest = t.api.getWeaknessView(p.id, sid).rows.filter((r) => r.mastery < 70).map((r) => r.unitId);
    expect(weakest).toContain(daily.problems[0].unitId);

    // 解いて提出 → 採点 → 苦手マップに記録が増える
    const before = t.api.getWeaknessView(p.id, sid).rows.reduce((n, r) => n + r.attempts, 0);
    const dailyIds = [p.id, sid, daily.id] as const;
    const v = await submitAndGrade(t, dailyIds, {});
    expect(v.test.status).toBe('graded');
    expect(t.api.getWeaknessView(p.id, sid).rows.reduce((n, r) => n + r.attempts, 0)).toBe(before + daily.problems.length);
    expect(t.api.recentResults(p.id)[0]).toMatchObject({ testId: daily.id, score: 0 });

    // 翌日: 新しい日の課題になる(昨日の課題は「今日の課題」には出ない)。復習はまだ
    process.env.ME_TODAY = addDays(TODAY, 1);
    expect(t.api.getTodayView(p.id).subjects.every((s) => s.test === null)).toBe(true);
    // 翌々日: 期限の来た復習が、もとの問題の類題として入る
    process.env.ME_TODAY = addDays(TODAY, 2);
    const view2 = t.api.getTodayView(p.id);
    expect(view2.subjects.find((s) => s.subjectId === sid)?.dueReviews ?? t.api.getReview(p.id, sid).items.length).toBeGreaterThan(0);
    await done(t, t.api.startCreateDaily(p.id, sid));
    const day3 = t.api.listTests(p.id, sid).find((x) => x.kind === 'daily' && x.date === addDays(TODAY, 2))!;
    const reviews = day3.problems.filter((q) => q.origin === 'review');
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews[0].reviewOf).toMatchObject({ testId: ids[2] });
    expect(reviews[0].body).toContain('復習');

    // 復習に正解すると、次は5日後
    const key = reviews[0].body.match(/\$(\d+) \+ (\d+)\$/)!;
    await submitAndGrade(t, [p.id, sid, day3.id], { [reviews[0].id]: String(Number(key[1]) + Number(key[2])) });
    const item = t.api.getReview(p.id, sid).items.find((i) => i.testId === reviews[0].reviewOf!.testId && i.problemId === reviews[0].reviewOf!.problemId)!;
    expect(item).toMatchObject({ intervalDays: 5, streak: 1, due: addDays(TODAY, 7) });
  });

  it('過去問の傾向があれば、類題が入る', async () => {
    const { t, p, sid } = await setupTest();
    const exam = importFake(t, p.id, sid, 1, 'past_exam', '過去問');
    await done(t, t.api.startReadSource(p.id, sid, exam));
    t.api.confirmSource(p.id, sid, exam);
    await done(t, t.api.startUpdateTrend(p.id, sid));
    await done(t, t.api.startCreateDaily(p.id, sid));
    const daily = t.api.listTests(p.id, sid).find((x) => x.kind === 'daily')!;
    expect(daily.problems.some((q) => q.origin === 'similar')).toBe(true);
    expect(daily.problems.find((q) => q.origin === 'similar')!.body).toContain('過去問の類題・傾向反映');
  });

  it('予定の日が来たら、通しの模擬試験を作れる(計画に結び付く)', async () => {
    const { t, p, sid } = await setupTest();
    await done(t, t.api.startCreatePlan(p.id));
    const plan = t.api.getPlanView(p.id).plan!;
    const mock = plan.mocks.find((m) => m.subjectId === sid)!;
    expect(dueMocks(plan, TODAY)).toEqual([]);
    expect(t.api.getTodayView(p.id).mocks).toEqual([]);
    expect((await settled(t, t.api.startCreateMock(p.id, sid))).error?.message).toContain('予定の模擬試験がありません');

    process.env.ME_TODAY = mock.date;
    expect(t.api.getTodayView(p.id).mocks.map((m) => m.subjectId)).toContain(sid);
    await done(t, t.api.startCreateMock(p.id, sid));
    const test = t.api.listTests(p.id, sid).find((x) => x.kind === 'mock')!;
    expect(test).toMatchObject({ kind: 'mock', timeLimitMin: 90, date: mock.date });
    expect(test.title).toContain('通しの模擬試験');
    expect(t.api.getPlanView(p.id).plan!.mocks.find((m) => m.subjectId === sid && m.date === mock.date)!.testId).toBe(test.id);
    // 作ったあとは「今日の課題」にそのテストが出る。同じ予定で2回は作れない
    expect(t.api.getTodayView(p.id).mocks.find((m) => m.subjectId === sid)!.test!.id).toBe(test.id);
    expect((await settled(t, t.api.startCreateMock(p.id, sid))).status).toBe('failed');
    // 予定日を1週間以上過ぎたものは出さない
    process.env.ME_TODAY = addDays(mock.date, 7);
    expect(dueMocks(plan, addDays(mock.date, 7)).filter((m) => m.date === mock.date)).toEqual([]);
  });
});
