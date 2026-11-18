import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../../src/core/claude/prompts';
import { TrendOutputSchema } from '../../src/shared/schema';
import { done, importFake, makeCore, sampleInput, settled } from './helpers';

describe('傾向のプロンプトと型', () => {
  it('まとめる項目と「過去問に書かれていることだけ」の決まりが入る', () => {
    const p = buildPrompt({ kind: 'trend', vars: { subjectName: '数学', university: 'テスト大学', faculty: '理学部' }, inputFile: 'in.json', outputFile: 'out.json', schema: TrendOutputSchema });
    for (const w of ['テスト大学 理学部', '"format"', '"structure"', '"frequentUnits"', '"volume"', '"timeAllocation"', '"difficulty"', '"summaryMd"', '入力の過去問に書かれていることだけ']) expect(p, w).toContain(w);
    expect(TrendOutputSchema.safeParse({ format: 'x' }).success).toBe(false);
  });
});

describe('志望校の傾向(偽 Claude)', () => {
  it('確定した過去問だけから作る。過去問が増えたら更新する', async () => {
    const t = makeCore();
    const p = t.api.createProject(sampleInput);
    const sid = p.subjects[0].id;
    const sp = t.core.paths(p.id).subject(sid);

    // 確定した過去問が無ければ、作れない(未確定・ほかの種類の資料は材料にしない)
    const exam1 = importFake(t, p.id, sid, 2, 'past_exam', '2025年度 過去問');
    const workbook = importFake(t, p.id, sid, 1, 'workbook', '問題集');
    await done(t, t.api.startReadSource(p.id, sid, exam1));
    await done(t, t.api.startReadSource(p.id, sid, workbook));
    t.api.confirmSource(p.id, sid, workbook);
    expect(t.api.getTrendView(p.id, sid)).toMatchObject({ trend: null, pastExams: [], stale: false, suggestRediagnosis: false });
    const failed = await settled(t, t.api.startUpdateTrend(p.id, sid));
    expect(failed.status).toBe('failed');
    expect(failed.error?.message).toContain('確定した過去問がありません');

    t.api.confirmSource(p.id, sid, exam1);
    expect(t.api.getTrendView(p.id, sid).stale).toBe(true);
    const job = await done(t, t.api.startUpdateTrend(p.id, sid));
    expect(job.title).toContain('志望校の傾向');
    const v1 = t.api.getTrendView(p.id, sid);
    expect(v1.stale).toBe(false);
    expect(v1.pastExams).toEqual([{ id: exam1, title: '2025年度 過去問', used: true }]);
    expect(v1.trend!.basedOn).toEqual([exam1]);
    expect(v1.trend!.format).toContain('選択式');
    expect(v1.trend!.structure.map((s) => s.label)).toEqual(['第1問', '第2問']);
    expect(v1.trend!.frequentUnits[0].unit).toContain(' > '); // 単元は名前で渡る
    expect(v1.trend!.volume).toContain('過去問 1 件で、設問は合わせて 4 問');
    expect(v1.trend!.summaryMd).toContain('初めてのまとめ');
    // 人が読める trend.md
    const md = readFileSync(sp.trendMd, 'utf8');
    expect(md).toContain('# 数学II・B・C の出題傾向');
    expect(md).toContain('## 大問構成');
    expect(md).toContain('2025年度 過去問');

    // 過去問を足して確定 → 「変わっています」→ 更新すると2件から作り直す(前回のまとめを土台に)
    const exam2 = importFake(t, p.id, sid, 1, 'past_exam', '2024年度 過去問');
    await done(t, t.api.startReadSource(p.id, sid, exam2));
    expect(t.api.getTrendView(p.id, sid).stale).toBe(false); // 未確定のうちは数えない
    t.api.confirmSource(p.id, sid, exam2);
    const v2 = t.api.getTrendView(p.id, sid);
    expect(v2.stale).toBe(true);
    expect(v2.pastExams.find((s) => s.id === exam2)!.used).toBe(false);
    await done(t, t.api.startUpdateTrend(p.id, sid));
    const v3 = t.api.getTrendView(p.id, sid);
    expect(v3.stale).toBe(false);
    expect(v3.trend!.basedOn.sort()).toEqual([exam1, exam2].sort());
    expect(v3.trend!.summaryMd).toContain('前回のまとめを更新');
    expect(v3.trend!.volume).toContain('過去問 2 件');

    // 確定を外すと、また「変わっています」
    t.api.unconfirmSource(p.id, sid, exam2);
    expect(t.api.getTrendView(p.id, sid).stale).toBe(true);
    expect(existsSync(sp.trendJson)).toBe(true);
  });

  it('過去問が入ったら再診断を提案する。作り直すと提案は消え、問題づくりに傾向が渡る', async () => {
    const t = makeCore();
    const p = t.api.createProject(sampleInput);
    const sid = p.subjects[0].id;
    await done(t, t.api.startCreateDiagnostic(p.id, sid));
    expect(t.api.listTests(p.id, sid)[0].problems[0].body).not.toContain('傾向反映');

    const exam = importFake(t, p.id, sid, 1, 'past_exam', '過去問');
    await done(t, t.api.startReadSource(p.id, sid, exam));
    t.api.confirmSource(p.id, sid, exam);
    expect(t.api.getTrendView(p.id, sid).suggestRediagnosis).toBe(false); // まだ傾向が無い
    await new Promise((r) => setTimeout(r, 5));
    await done(t, t.api.startUpdateTrend(p.id, sid));
    expect(t.api.getTrendView(p.id, sid).suggestRediagnosis).toBe(true);

    await new Promise((r) => setTimeout(r, 5));
    await done(t, t.api.startCreateDiagnostic(p.id, sid));
    expect(t.api.getTrendView(p.id, sid).suggestRediagnosis).toBe(false);
    const tests = t.api.listTests(p.id, sid);
    expect(tests).toHaveLength(2);
    expect(tests[0].problems[0].body).toContain('傾向反映');
  });
});
