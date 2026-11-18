import { describe, expect, it } from 'vitest';
import { applyGrading, buildWeaknessView, computeMastery, creditOf, dominantMistake, recencyWeight, HALF_LIFE_DAYS } from '../../src/core/weakness';
import { addDays } from '../../src/shared/dates';
import type { Difficulty, Grading, MistakeType, Test, Weakness, WeaknessEvent } from '../../src/shared/schema';
import { setupTest, submitAndGrade } from './helpers';

const TODAY = '2026-11-17';
const ev = (ratio: number, difficulty: Difficulty = 'standard', daysAgo = 0, mistake: MistakeType | null = null): WeaknessEvent => ({
  date: addDays(TODAY, -daysAgo),
  testId: `t${daysAgo}`,
  problemId: 'p',
  ratio,
  difficulty,
  mistake,
});

describe('習熟度の式(正誤・難易度・新しさ)', () => {
  it('記録が無ければ 50。正解で上がり、誤答で下がる。回数が増えるほど 50 から離れる', () => {
    expect(computeMastery([], TODAY)).toBe(50);
    const right1 = computeMastery([ev(1)], TODAY);
    const right3 = computeMastery([ev(1), ev(1), ev(1)], TODAY);
    const wrong1 = computeMastery([ev(0)], TODAY);
    const wrong3 = computeMastery([ev(0), ev(0), ev(0)], TODAY);
    expect(right1).toBeGreaterThan(50);
    expect(right3).toBeGreaterThan(right1);
    expect(wrong1).toBeLessThan(50);
    expect(wrong3).toBeLessThan(wrong1);
    for (const m of [right1, right3, wrong1, wrong3]) {
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(100);
    }
    // 部分点は、その割合ぶん
    expect(computeMastery([ev(0.5)], TODAY)).toBeGreaterThan(wrong1);
    expect(computeMastery([ev(0.5)], TODAY)).toBeLessThan(right1);
  });

  it('難しい問題の正解ほど高く、易しい問題の誤答ほど低い', () => {
    expect(creditOf(1, 'target')).toBeGreaterThan(creditOf(1, 'standard'));
    expect(creditOf(1, 'standard')).toBeGreaterThan(creditOf(1, 'easy'));
    expect(creditOf(0, 'easy')).toBeLessThan(creditOf(0, 'standard'));
    expect(creditOf(0, 'standard')).toBeLessThan(creditOf(0, 'target'));
    expect(computeMastery([ev(1, 'target')], TODAY)).toBeGreaterThan(computeMastery([ev(1, 'easy')], TODAY));
    expect(computeMastery([ev(0, 'easy')], TODAY)).toBeLessThan(computeMastery([ev(0, 'target')], TODAY));
    expect(creditOf(2, 'easy')).toBe(creditOf(1, 'easy')); // 範囲外の得点率は丸める
  });

  it('古い結果ほど軽い: 昔の誤答より最近の正解が効く。古い記録だけなら 50 に近づく', () => {
    expect(recencyWeight(0)).toBe(1);
    expect(recencyWeight(HALF_LIFE_DAYS)).toBeCloseTo(0.5);
    expect(recencyWeight(HALF_LIFE_DAYS * 2)).toBeCloseTo(0.25);
    expect(recencyWeight(-5)).toBe(1);
    const improving = computeMastery([ev(0, 'standard', 90), ev(1, 'standard', 0)], TODAY);
    const declining = computeMastery([ev(1, 'standard', 90), ev(0, 'standard', 0)], TODAY);
    expect(improving).toBeGreaterThan(declining);
    expect(improving).toBeGreaterThan(60);
    const fresh = computeMastery([ev(0)], TODAY);
    const stale = computeMastery([ev(0, 'standard', 180)], TODAY);
    expect(stale).toBeGreaterThan(fresh);
    expect(stale).toBeLessThan(50);
  });
});

describe('採点結果からの更新', () => {
  const test = { id: 'tA' } as Test;
  const grading = (scores: number[], override?: number): Grading => ({
    version: 1,
    testId: 'tA',
    gradedAt: '2026-11-17T03:00:00.000Z',
    overrides: [],
    items: scores.map((score, i) => ({
      problemId: `p${i + 1}`,
      score,
      max: 10,
      rationale: '',
      mistake: score >= 10 ? null : (['calculation', 'knowledge'] as const)[i % 2],
      comment: '',
      unitId: i < 2 ? 'u1' : 'u2',
      unitName: i < 2 ? '単元1' : '単元2',
      difficulty: 'standard',
      override: i === 0 && override !== undefined ? { score: override, note: '', at: '' } : null,
    })),
  });
  const empty: Weakness = { version: 1, units: {}, updatedAt: null };

  it('単元ごとに記録が入り、ミスの種類が数えられる。満点にはミスを付けない', () => {
    const w = applyGrading(empty, test, grading([0, 10, 5]), TODAY);
    expect(Object.keys(w.units).sort()).toEqual(['u1', 'u2']);
    expect(w.units.u1.events.map((e) => [e.ratio, e.mistake])).toEqual([
      [0, 'calculation'],
      [1, null],
    ]);
    expect(w.units.u2.events[0]).toMatchObject({ ratio: 0.5, mistake: 'calculation', date: TODAY, testId: 'tA' });
    expect(w.units.u1.history).toEqual([{ date: TODAY, mastery: w.units.u1.mastery }]);
    const view = buildWeaknessView(w, new Map([['u1', { weight: 3, fullName: '親 > 単元1', leaf: true }], ['u9', { weight: 1, fullName: '未出題', leaf: true }], ['u8', { weight: 0, fullName: '扱わない', leaf: true }]]), TODAY);
    expect(view.rows.map((r) => r.unitName)).toContain('親 > 単元1');
    expect(view.rows.find((r) => r.unitId === 'u1')!.mistakes).toMatchObject({ calculation: 1, knowledge: 0 });
    expect(view.untested).toBe(1);
    expect(view.overall).toBeGreaterThan(0);
    expect(dominantMistake(view.rows.find((r) => r.unitId === 'u1')!)).toBe('calculation');
    expect(buildWeaknessView(empty, new Map(), TODAY)).toMatchObject({ rows: [], overall: null });
  });

  it('同じテストをもう一度反映しても二重に数えない(上書きは点数だけが変わり、日付は最初のまま)', () => {
    const w1 = applyGrading(empty, test, grading([0, 10, 5]), TODAY);
    const later = addDays(TODAY, 3);
    const w2 = applyGrading(w1, test, grading([0, 10, 5], 10), later);
    expect(w2.units.u1.events).toHaveLength(2);
    expect(w2.units.u1.events.every((e) => e.date === TODAY)).toBe(true);
    expect(w2.units.u1.events[0]).toMatchObject({ ratio: 1, mistake: null });
    expect(w2.units.u1.mastery).toBeGreaterThan(w1.units.u1.mastery);
    expect(w2.units.u1.history.map((h) => h.date)).toEqual([TODAY, later]);
    // 別のテストは足される。日をまたいだ推移が残る
    const w3 = applyGrading(w2, { id: 'tB' } as Test, { ...grading([10, 10, 10]), testId: 'tB' }, later);
    expect(w3.units.u1.events).toHaveLength(4);
    expect(w3.units.u1.history).toHaveLength(2);
    expect(w3.units.u2.mastery).toBeGreaterThan(w2.units.u2.mastery);
  });
});

describe('採点 → 苦手マップ(偽 Claude での一連の流れ)', () => {
  it('採点すると苦手マップができ、上書きすると習熟度が変わる', async () => {
    const { t, ids, p, sid, test } = await setupTest();
    expect(t.api.getWeaknessView(p.id, sid)).toMatchObject({ rows: [], overall: null });
    expect(t.api.subjectSummaries(p.id)[0]).toMatchObject({ mastery: null, gap: null, target: 75 });
    await submitAndGrade(t, ids, { p01: '2', p02: '99', p03: '位ごとに足すと 30 くらい' });

    const v = t.api.getWeaknessView(p.id, sid);
    expect(v.rows).toHaveLength(4);
    expect(v.rows[0].mastery).toBeLessThanOrEqual(v.rows[3].mastery); // 弱い順
    const byUnit = (problemIndex: number) => v.rows.find((r) => r.unitId === test.problems[problemIndex].unitId)!;
    expect(byUnit(0).mastery).toBeGreaterThan(50); // 正解
    expect(byUnit(1).mastery).toBeLessThan(50); // 誤答
    expect(byUnit(1).mistakes.calculation).toBe(1);
    expect(byUnit(3).mistakes.blank).toBe(1);
    expect(byUnit(0).unitName).toContain(' > ');
    expect(v.untested).toBeGreaterThan(10);

    const s = t.api.subjectSummaries(p.id)[0];
    expect(s.mastery).toBe(v.overall);
    expect(s.gap).toBeCloseTo(75 - v.overall!, 1);
    expect(s.weakest).toHaveLength(3);

    const before = byUnit(1).mastery;
    t.api.overrideGrade(...ids, 'p02', 10, '実は合っていた');
    const after = t.api.getWeaknessView(p.id, sid).rows.find((r) => r.unitId === test.problems[1].unitId)!;
    expect(after.mastery).toBeGreaterThan(before);
    expect(after.attempts).toBe(1);
    expect(after.mistakes.calculation).toBe(0);
  });
});
