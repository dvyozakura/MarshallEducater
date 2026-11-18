import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../../src/core/claude/prompts';
import { effectiveScore, gradingTotals } from '../../src/core/grading';
import { Files, readData } from '../../src/core/store';
import { GradeOutputSchema } from '../../src/shared/schema';
import { done, importFake, settled, setupTest, submitAndGrade } from './helpers';

describe('採点のプロンプトと型', () => {
  it('ミスの種類・部分点・所見の決まりが入る', () => {
    const p = buildPrompt({ kind: 'grade', vars: { subjectName: '数学', testTitle: '診断' }, inputFile: 'in.json', outputFile: 'out.json', schema: GradeOutputSchema });
    for (const w of ['knowledge', 'approach', 'calculation', 'misread', 'timeout', 'blank', '部分点', '"rationale"', '"mistake"', '"comment"']) expect(p, w).toContain(w);
    expect(GradeOutputSchema.safeParse({ items: [{ problemId: 'p1', score: -1, rationale: '' }] }).success).toBe(false);
    expect(GradeOutputSchema.safeParse({ items: [{ problemId: 'p1', score: 3, rationale: 'x', mistake: 'careless' }] }).success).toBe(false);
    expect(GradeOutputSchema.parse({ items: [{ problemId: 'p1', score: 3, rationale: 'x' }] }).items[0]).toMatchObject({ mistake: null, comment: '' });
  });
});

describe('採点(偽 Claude)', () => {
  it('正解・誤答・部分点・未解答を採点し、単元とミスの種類と所見を付ける', async () => {
    const { t, ids, test } = await setupTest();
    expect(t.api.getResultView(...ids)).toMatchObject({ grading: null, key: null, totals: null });
    const v = await submitAndGrade(t, ids, { p01: '2', p02: '99', p03: '位ごとに足すと 30 くらい' });
    expect(v.test.status).toBe('graded');
    expect(v.totals).toEqual({ score: 20, max: 50 });
    const [a, b, c, d] = v.grading!.items;
    expect(a).toMatchObject({ problemId: 'p01', score: 10, max: 10, mistake: null, unitId: test.problems[0].unitId, difficulty: 'easy' });
    expect(b).toMatchObject({ score: 0, mistake: 'calculation' });
    expect(b.comment).toContain('和の計算');
    expect(c).toMatchObject({ score: 10, max: 20, mistake: 'calculation' }); // 記述の部分点と根拠
    expect(c.rationale).toContain('考え方の説明');
    expect(d).toMatchObject({ score: 0, mistake: 'blank' }); // 未解答は Claude に送らない
    expect(c.unitName).toBe(test.problems[2].unitName);
    // 採点が済んだら、正解を見られる
    expect(v.key!.items).toHaveLength(4);
    const call = t.fake.calls().at(-1)!;
    expect(call.kind).toBe('grade');
    expect(call.prompt).toContain(test.title);
  });

  it('全問が未解答なら Claude を呼ばない。制限時間を使い切っていれば「時間切れ」', async () => {
    const { t, ids } = await setupTest();
    const before = t.fake.calls().length;
    const v = await submitAndGrade(t, ids, {}, 40 * 60);
    expect(t.fake.calls().length).toBe(before);
    expect(v.grading!.items.every((i) => i.mistake === 'timeout' && i.score === 0)).toBe(true);
    expect(v.totals).toEqual({ score: 0, max: 50 });
  });

  it('選択式の正誤は手元でも確かめる(記号で書かれた答えも番号として扱う)。減点にミスの種類が無ければやり直させる', async () => {
    const { t, ids } = await setupTest({ kinds: { grade: ['no_mistake', 'ok'] } });
    const v = await submitAndGrade(t, ids, { p01: '②', p02: '1' });
    expect(v.grading!.items[0]).toMatchObject({ score: 10, mistake: null });
    const grades = t.fake.calls().filter((c) => c.kind === 'grade');
    expect(grades).toHaveLength(2);
    expect(grades[1].prompt).toContain('減点があるのに mistake が null');
  });

  it('確定していない答案は採点に流れない', async () => {
    const { t, p, sid, test, ids } = await setupTest();
    const job1 = await settled(t, t.api.startGrade(...ids));
    expect(job1.status).toBe('failed');
    expect(job1.error?.message).toContain('まだ出されていません');

    const sourceId = importFake(t, p.id, sid, 1, 'answer', '紙の答案', test.id);
    await done(t, t.api.startReadSource(p.id, sid, sourceId));
    const job2 = await settled(t, t.api.startGrade(...ids));
    expect(job2.status).toBe('failed');
    expect(job2.error?.message).toContain('まだ出されていません');
    t.api.confirmSource(p.id, sid, sourceId);
    t.api.unconfirmSource(p.id, sid, sourceId);
    const job3 = await settled(t, t.api.startGrade(...ids));
    expect(job3.error?.message).toContain('まだ確定されていません');
    expect(t.api.getResultView(...ids).grading).toBeNull();

    t.api.confirmSource(p.id, sid, sourceId);
    await done(t, t.api.startGrade(...ids));
    expect(t.api.getResultView(...ids).test.status).toBe('graded');
  });
});

describe('採点結果の上書き', () => {
  it('上書きと取り消しが記録され、合計に反映される。読み直しても残る', async () => {
    const { t, ids, p, sid, test } = await setupTest();
    await submitAndGrade(t, ids, { p01: '2', p02: '99', p03: '位ごとに足すと 30 くらい' });
    expect(() => t.api.overrideGrade(...ids, 'p02', 11, '')).toThrow('0〜10');
    expect(() => t.api.overrideGrade(...ids, 'p99', 1, '')).toThrow('このテストにありません');

    const g1 = t.api.overrideGrade(...ids, 'p02', 5, '途中の式は合っている');
    expect(g1.items[1]).toMatchObject({ score: 0, override: { score: 5, note: '途中の式は合っている' } });
    expect(effectiveScore(g1.items[1])).toBe(5);
    expect(gradingTotals(g1)).toEqual({ score: 25, max: 50 });
    t.api.overrideGrade(...ids, 'p02', 5, '途中の式は合っている'); // 同じ内容なら記録を増やさない
    const g2 = t.api.overrideGrade(...ids, 'p02', 8, '採点が厳しすぎる');
    const g3 = t.api.overrideGrade(...ids, 'p03', null, ''); // 上書きしていない設問の取り消しは何もしない
    expect(g3.overrides).toHaveLength(2);
    const g4 = t.api.overrideGrade(...ids, 'p02', null, '');
    expect(g4.items[1].override).toBeNull();
    expect(g4.overrides.map((o) => `${o.from}->${o.to}`)).toEqual(['0->5', '5->8', '8->0']);
    expect(g2.overrides[1].note).toBe('採点が厳しすぎる');

    t.api.overrideGrade(...ids, 'p03', 20, '説明は十分');
    const saved = readData(t.core.paths(p.id).subject(sid).test(test.id).gradingJson, Files.grading);
    expect(saved.items[2].override?.score).toBe(20);
    expect(t.api.getResultView(...ids).totals).toEqual({ score: 30, max: 50 });
  });
});
