import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPrompt } from '../../src/core/claude/prompts';
import { examState, PLAN_HORIZON_WEEKS, progressOf, scheduleMocks } from '../../src/core/plan';
import { addDays, daysBetween, splitWeeks } from '../../src/shared/dates';
import { PlanOutputSchema, type Plan } from '../../src/shared/schema';
import { done, makeCore, sampleInput, settled, setupTest, submitAndGrade } from './helpers';

const TODAY = '2026-11-17';
beforeEach(() => {
  process.env.ME_TODAY = TODAY;
});
afterEach(() => {
  delete process.env.ME_TODAY;
});

describe('日付まわり', () => {
  it('試験日が過去・当日・翌日', () => {
    expect(examState(TODAY, '2026-11-16')).toBe('past');
    expect(examState(TODAY, TODAY)).toBe('today');
    expect(examState(TODAY, '2026-11-18')).toBe('future');
    expect(splitWeeks(TODAY, '2026-11-16')).toEqual([]);
    expect(splitWeeks(TODAY, TODAY)).toEqual([]);
    expect(splitWeeks(TODAY, '2026-11-18')).toEqual([{ index: 0, start: TODAY, end: TODAY }]);
    // 年をまたぐ。最後の週は短い
    const weeks = splitWeeks('2026-12-28', '2027-01-13');
    expect(weeks.map((w) => `${w.start}~${w.end}`)).toEqual(['2026-12-28~2027-01-03', '2027-01-04~2027-01-10', '2027-01-11~2027-01-12']);
  });

  it('通しの模擬試験は、試験の2週前と4週前の週に、科目ごとに日をずらして入れる', () => {
    const weeks = splitWeeks(TODAY, addDays(TODAY, 42)); // ちょうど6週
    expect(weeks).toHaveLength(6);
    const mocks = scheduleMocks(weeks, ['数学', '英語']);
    expect(mocks.map((m) => m.weekIndex)).toEqual([2, 2, 4, 4]);
    for (const m of mocks) {
      const w = weeks[m.weekIndex];
      expect(daysBetween(w.start, m.date)).toBeGreaterThanOrEqual(0);
      expect(daysBetween(m.date, w.end)).toBeGreaterThanOrEqual(0);
    }
    expect(mocks[0].date).not.toBe(mocks[1].date);
    // 試験までが短いとき
    expect(scheduleMocks(weeks.slice(0, 1), ['数学'])).toEqual([]);
    expect(scheduleMocks(weeks.slice(0, 2), ['数学']).map((m) => m.weekIndex)).toEqual([0]);
    expect(scheduleMocks(weeks.slice(0, 3), ['数学']).map((m) => m.weekIndex)).toEqual([1]);
    // 1日しか無い週でも、その日に入る
    const short = [{ index: 0, start: TODAY, end: TODAY }, { index: 1, start: addDays(TODAY, 1), end: addDays(TODAY, 1) }];
    expect(scheduleMocks(short, ['a', 'b', 'c']).every((m) => m.date === TODAY)).toBe(true);
  });

  it('やれた日・やれなかった日は、計画を作った日から昨日までの最大7日で数える', () => {
    const plan = { startDate: TODAY } as Plan;
    expect(progressOf(plan, TODAY, new Set())).toEqual({ doneDays: 0, missedDays: 0 });
    expect(progressOf(plan, addDays(TODAY, 3), new Set([addDays(TODAY, 1)]))).toEqual({ doneDays: 1, missedDays: 2 });
    expect(progressOf(plan, addDays(TODAY, 30), new Set())).toEqual({ doneDays: 0, missedDays: 7 });
  });
});

describe('学習計画のプロンプトと型', () => {
  it('作り直しのときは、その旨と理由が入る', () => {
    const p = buildPrompt({ kind: 'plan', vars: { revisionNote: 'これは **作り直し** です(理由: 遅れた)。' }, inputFile: 'in.json', outputFile: 'out.json', schema: PlanOutputSchema });
    for (const w of ['理由: 遅れた', '"weeks"', '"theme"', '"unitIds"', '"minutes"', '"advice"', '8割ほどに抑えて']) expect(p, w).toContain(w);
    expect(PlanOutputSchema.safeParse({ weeks: [{ theme: 'x', items: [{ subjectId: 's', unitIds: [], minutes: -1 }] }], advice: '' }).success).toBe(false);
  });
});

describe('学習計画の作成と作り直し(偽 Claude)', () => {
  it('試験日から逆算して週ごとの計画を作る。苦手マップの弱い単元が入る。模擬試験の予定が付く', async () => {
    const { t, p, sid, ids, test } = await setupTest();
    await submitAndGrade(t, ids, { p01: '2', p02: '99' });
    expect(t.api.getPlanView(p.id)).toMatchObject({ plan: null, exam: 'future', late: false });
    const job = await done(t, t.api.startCreatePlan(p.id));
    expect(job.title).toBe('学習計画の作成');

    const v = t.api.getPlanView(p.id);
    const plan = v.plan!;
    // 2026-11-17 〜 2027-02-24(試験の前日)= 100 日 → 15 週(最後は2日)
    expect(plan.weeks).toHaveLength(15);
    expect(plan.weeks[0]).toMatchObject({ index: 0, start: TODAY, end: '2026-11-23' });
    expect(plan.weeks[14]).toMatchObject({ start: '2027-02-23', end: '2027-02-24', theme: '総復習と体調の調整' });
    expect(plan).toMatchObject({ startDate: TODAY, examDate: '2027-02-25', dailyMinutes: 180, revision: 0, reason: '' });
    expect(v.currentWeek).toBe(0);
    expect(v.late).toBe(false);
    // 科目ごとの時間。1週間の合計は、使える時間の8割以内
    expect(plan.weeks[0].items.map((i) => i.subjectId)).toEqual(p.subjects.map((s) => s.id));
    expect(plan.weeks[0].items.reduce((n, i) => n + i.minutes, 0)).toBeLessThanOrEqual(180 * 7 * 0.8);
    // 採点で弱いと分かった単元(誤答・未解答)が入っている
    const weak = t.api.getWeaknessView(p.id, sid).rows[0].unitId;
    expect(plan.weeks.flatMap((w) => w.items.filter((i) => i.subjectId === sid).flatMap((i) => i.unitIds))).toContain(weak);
    expect(test.problems.map((q) => q.unitId)).toContain(weak);
    // 模擬試験: 2週前と4週前に、2科目ずつ
    expect(plan.mocks).toHaveLength(4);
    expect(plan.weeks.filter((w) => w.mock).map((w) => w.index)).toEqual([11, 13]);
    expect(plan.advice).toContain('最初の計画');
    expect(t.fake.calls().at(-1)!.prompt).toContain('これが最初の計画です');
  });

  it('やらなかった日が続いたら作り直しを提案し、残りの日数で作り直せる', async () => {
    const t = makeCore();
    const p = t.api.createProject(sampleInput);
    await done(t, t.api.startCreatePlan(p.id));
    process.env.ME_TODAY = addDays(TODAY, 2);
    expect(t.api.getPlanView(p.id)).toMatchObject({ late: false, progress: { doneDays: 0, missedDays: 2 } });

    process.env.ME_TODAY = addDays(TODAY, 10);
    const v = t.api.getPlanView(p.id);
    expect(v).toMatchObject({ late: true, currentWeek: 1, progress: { doneDays: 0, missedDays: 7 } });
    // 古い計画のままでも、今週の計画は引ける(破綻しない)
    expect(v.plan!.weeks[v.currentWeek!].items.length).toBeGreaterThan(0);

    const job = await done(t, t.api.startCreatePlan(p.id, '7日のうち7日できなかった'));
    expect(job.title).toBe('学習計画の作り直し');
    const v2 = t.api.getPlanView(p.id);
    expect(v2.plan).toMatchObject({ revision: 1, reason: '7日のうち7日できなかった', startDate: addDays(TODAY, 10) });
    expect(v2.plan!.weeks[0].start).toBe(addDays(TODAY, 10));
    expect(v2.plan!.weeks.at(-1)!.end).toBe('2027-02-24');
    expect(v2.plan!.advice).toContain('作り直しました(理由: 7日のうち7日できなかった)');
    expect(v2).toMatchObject({ late: false, currentWeek: 0 }); // 作り直した日から数え直す
    expect(t.fake.calls().at(-1)!.prompt).toContain('作り直し');
  });

  it('試験日が過去・当日なら作らない。翌日なら1日だけの計画になる', async () => {
    const t = makeCore();
    const p = t.api.createProject(sampleInput);
    process.env.ME_TODAY = '2027-02-26';
    expect(t.api.getPlanView(p.id).exam).toBe('past');
    const past = await settled(t, t.api.startCreatePlan(p.id));
    expect(past.status).toBe('failed');
    expect(past.error?.message).toContain('試験日を過ぎています');

    process.env.ME_TODAY = '2027-02-25';
    expect(t.api.getPlanView(p.id).exam).toBe('today');
    expect((await settled(t, t.api.startCreatePlan(p.id))).error?.message).toContain('今日が試験日です');
    expect(t.fake.calls()).toHaveLength(0);

    process.env.ME_TODAY = '2027-02-24';
    await done(t, t.api.startCreatePlan(p.id));
    const v = t.api.getPlanView(p.id);
    expect(v.plan!.weeks).toEqual([expect.objectContaining({ index: 0, start: '2027-02-24', end: '2027-02-24', mock: false })]);
    expect(v.plan!.mocks).toEqual([]);
    expect(v.plan!.weeks[0].items.reduce((n, i) => n + i.minutes, 0)).toBeLessThanOrEqual(180);
    expect(v).toMatchObject({ exam: 'future', currentWeek: 0, late: false });
    // 当日・翌日以降に開いても壊れない
    process.env.ME_TODAY = '2027-02-25';
    expect(t.api.getPlanView(p.id)).toMatchObject({ exam: 'today', currentWeek: null, late: false, outdated: null });
    process.env.ME_TODAY = '2027-03-10';
    expect(t.api.getPlanView(p.id)).toMatchObject({ exam: 'past', late: false });
  });

  it('試験がずっと先なら、近い半年ぶんだけ計画する。週の数が合わない出力はやり直させる。設定が変わったら作り直しをうながす', async () => {
    const t = makeCore({ kinds: { plan: ['short_weeks', 'ok'] } });
    const p = t.api.createProject({ ...sampleInput, examDate: '2028-02-25' });
    await done(t, t.api.startCreatePlan(p.id));
    const plans = t.fake.calls().filter((c) => c.kind === 'plan');
    expect(plans).toHaveLength(2);
    expect(plans[1].prompt).toContain('weeks の数が違います');
    const v = t.api.getPlanView(p.id);
    expect(v.plan!.weeks).toHaveLength(PLAN_HORIZON_WEEKS);
    expect(v.plan!.mocks).toEqual([]); // 模擬試験は、試験が近づいてから
    expect(v.outdated).toBeNull();

    t.api.updateProject(p.id, { ...sampleInput, examDate: '2027-06-01' });
    expect(t.api.getPlanView(p.id).outdated).toContain('試験日が変わりました');
    await done(t, t.api.startCreatePlan(p.id, '試験日が変わりました。'));
    expect(t.api.getPlanView(p.id)).toMatchObject({ outdated: null });
    expect(t.api.getPlanView(p.id).plan!.revision).toBe(1);
  });
});
