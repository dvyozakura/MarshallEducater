import { afterEach, describe, expect, it } from 'vitest';
import { getTodayView, todayReading } from '../../src/core/daily';
import { getAnswerKey } from '../../src/core/grading';
import { getPlan } from '../../src/core/plan';
import { suggestReading, type TextbookView } from '../../src/core/textbook';
import { done, makeCore, sampleInput, submitAndGrade } from './helpers';

afterEach(() => {
  delete process.env.ME_TODAY;
});

function setup(control: Record<string, unknown> = {}) {
  const t = makeCore(control);
  const p = t.api.createProject(sampleInput);
  const sid = p.subjects[0].id;
  const u = t.api.getTextbookView(p.id, sid).chapters.map((c) => c.unitId);
  return { t, p, sid, u };
}

describe('読む章のおすすめ', () => {
  it('未習 → 苦手(習熟度の低い順)→ 目次の順。既読と外れた章は入れない', () => {
    const row = (no: number, extra: Partial<TextbookView['chapters'][number]>) =>
      ({ unitId: `u${no}`, no, name: `単元${no}`, title: `親 > 単元${no}`, status: 'none', read: false, unlearned: false, orphan: false, mastery: null, ...extra }) as TextbookView['chapters'][number];
    const view = {
      chapters: [
        row(1, { mastery: 80 }),
        row(2, { mastery: 30 }),
        row(3, { read: true, unlearned: true }),
        row(4, { unlearned: true }),
        row(5, { mastery: 10 }),
        row(6, {}),
        row(0, { orphan: true, unlearned: true }),
      ],
    } as TextbookView;
    const s = suggestReading(view);
    expect(s.map((x) => x.unitId)).toEqual(['u4', 'u5', 'u2', 'u1', 'u6']);
    expect(s.map((x) => x.reason)).toEqual(['未習の単元', '苦手な単元(習熟度 10)', '苦手な単元(習熟度 30)', '目次の順', '目次の順']);
    expect(suggestReading(view, 2)).toHaveLength(2);
  });
});

describe('学習計画と今日の課題に「教材の第N章を読む」', () => {
  it('計画: 読む章のおすすめを渡し、各週の chapterUnitIds に入る(目次に無い章は捨てる)。今日の課題は今週の計画の章を出す', async () => {
    process.env.ME_TODAY = '2026-12-01';
    const { t, p, sid, u } = setup({ kinds: { plan: ['bad_chapter'] } });
    t.api.setChapterUnlearned(p.id, sid, u[5], true);
    // 計画を作る前: おすすめ(未習の章が先)
    let r = getTodayView(t.core, p.id).subjects[0]?.reading ?? todayReading(t.core, p.id, sid, null, '2026-12-01')!;
    expect(r).toMatchObject({ unitId: u[5], fromPlan: false, reason: '未習の単元' });
    expect(r.label).toMatch(/^教材の第6章「.+」を読む$/);

    await done(t, t.api.startCreatePlan(p.id));
    const plan = getPlan(t.core, p.id)!;
    const week0 = plan.weeks[0].items.find((i) => i.subjectId === sid)!;
    expect(week0.chapterUnitIds).toEqual([u[5]]); // 'no-such-unit' は捨てる
    expect(week0.goal).toContain('教材の第6章を読む');
    expect(plan.weeks[1].items.find((i) => i.subjectId === sid)!.chapterUnitIds).toEqual([u[0]]);
    const view = t.api.getPlanView(p.id);
    expect(view.chapterLabels[`${sid}/${u[5]}`]).toMatch(/^教材の第6章/);

    // 今日の課題: 今週の計画の章
    r = getTodayView(t.core, p.id).subjects.find((s) => s.subjectId === sid)!.reading!;
    expect(r).toMatchObject({ unitId: u[5], fromPlan: true });
    expect(r.reason).toContain('今週の計画');
    expect(r.status).toBe('none'); // まだ作っていない章も「読む」に出る(開くと作れる)
    // 作って読んだら(既読)、次のおすすめに移る
    await done(t, t.api.startCreateChapter(p.id, sid, u[5]));
    t.api.setChapterRead(p.id, sid, u[5], true);
    r = getTodayView(t.core, p.id).subjects.find((s) => s.subjectId === sid)!.reading!;
    expect(r).toMatchObject({ unitId: u[0], fromPlan: false });
  });
});

describe('確認問題を既存の流れに流す', () => {
  it('章の確認問題を解いて提出 → 採点 → 苦手マップに反映 → 目次に「確認問題: 何問中何問」', async () => {
    const { t, p, sid, u } = setup();
    await done(t, t.api.startCreateChapter(p.id, sid, u[0]));
    let row = t.api.getTextbookView(p.id, sid).chapters[0];
    const testId = row.quizTestId!;
    expect(row.quiz).toMatchObject({ status: 'ready', total: 3, correct: null });
    const key = getAnswerKey(t.core, p.id, sid, testId);
    // 1問目だけ正解、ほかは未解答
    const result = await submitAndGrade(t, [p.id, sid, testId], { [key.items[0].problemId]: key.items[0].answer });
    expect(result.totals).toBeTruthy();
    row = t.api.getTextbookView(p.id, sid).chapters[0];
    expect(row.quiz).toMatchObject({ status: 'graded', total: 3, correct: 1 });
    // 苦手マップ: その単元に記録が入る(習熟度が付く)
    const w = t.api.getWeaknessView(p.id, sid).rows.find((r) => r.unitId === u[0])!;
    expect(w.attempts).toBe(3);
    expect(row.mastery).toBe(w.mastery);
  });
});
