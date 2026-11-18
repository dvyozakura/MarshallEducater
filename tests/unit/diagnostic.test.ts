import { describe, expect, it } from 'vitest';
import { buildPrompt, loadPromptSection } from '../../src/core/claude/prompts';
import { weakUnits } from '../../src/core/diagnostic';
import { answerSheetHtml, bookletHtml, KATEX_CSS_PLACEHOLDER } from '../../src/core/print';
import { Files, readData } from '../../src/core/store';
import { DesignTestOutputSchema } from '../../src/shared/schema';
import { done, makeCore, sampleInput } from './helpers';

describe('テストの設計のプロンプトと型', () => {
  it('診断用と模試用で決まりが切り替わる', () => {
    const vars = { subjectName: '数学', purpose: '実力診断テスト', rules: loadPromptSection('design_test_rules', 'diagnostic') };
    const p = buildPrompt({ kind: 'design_test', vars, inputFile: 'in.json', outputFile: 'out.json', schema: DesignTestOutputSchema });
    expect(p).toContain('単元を広く覆う');
    expect(p).toContain('30〜60分');
    expect(p).toContain('"timeLimitMin"');
    expect(p).not.toContain('本番と同じ形式・同じ時間で通して解く練習');
    expect(loadPromptSection('design_test_rules', 'mock')).toContain('本番');
    expect(() => loadPromptSection('design_test_rules', 'nothing')).toThrow();
    expect(DesignTestOutputSchema.safeParse({ timeLimitMin: 40, items: [] }).success).toBe(false);
    expect(DesignTestOutputSchema.safeParse({ timeLimitMin: 40, items: [{ unitId: 'u', difficulty: 'easy', format: 'mark' }] }).success).toBe(false);
  });

  it('弱い単元は、記録のあるものを習熟度の低い順に', () => {
    const w = { version: 1, updatedAt: null, units: { a: { unitName: 'A', mastery: 70, events: [{}], history: [] }, b: { unitName: 'B', mastery: 20, events: [{}], history: [] }, c: { unitName: 'C', mastery: 10, events: [], history: [] } } };
    expect(weakUnits(w as never).map((u) => u.unitId)).toEqual(['b', 'a']);
    expect(weakUnits(null)).toEqual([]);
  });
});

describe('実力診断テストの作成(偽 Claude)', () => {
  it('設計 → 作成 → 検算 → 保存。過去問が無くても作れる。2回目は題名で区別する', async () => {
    const t = makeCore({ options: { designCount: 6 } });
    const p = t.api.createProject(sampleInput);
    const sid = p.subjects[0].id;
    const job = await done(t, t.api.startCreateDiagnostic(p.id, sid));
    expect(job.title).toContain('実力診断テストの作成');
    expect(t.fake.calls().map((c) => c.kind)).toEqual(['design_test', 'generate_problems', 'solve_problems', 'judge_answers']);

    const [test] = t.api.listTests(p.id, sid);
    expect(test).toMatchObject({ kind: 'diagnostic', title: '数学II・B・C 実力診断テスト', timeLimitMin: 40, status: 'ready' });
    expect(test.instructions).toContain('空欄');
    expect(test.problems).toHaveLength(6);
    // 単元を広く覆い、難易度を混ぜる(国公立二次型なので記述・短答を含む)
    expect(new Set(test.problems.map((q) => q.unitId)).size).toBe(6);
    expect(new Set(test.problems.map((q) => q.difficulty))).toEqual(new Set(['easy', 'standard', 'target']));
    expect(new Set(test.problems.map((q) => q.format))).toEqual(new Set(['choice', 'short', 'essay']));
    expect(test.problems.every((q) => q.origin === 'diagnostic')).toBe(true);
    expect(t.api.getVerify(p.id, sid, test.id)!.counts.adopted).toBe(6);
    expect(readData(t.core.paths(p.id).subject(sid).test(test.id).answerKeyJson, Files.answerKey).items).toHaveLength(6);

    await done(t, t.api.startCreateDiagnostic(p.id, sid));
    expect(t.api.listTests(p.id, sid).map((x) => x.title)).toContain('数学II・B・C 実力診断テスト(2回目)');
  });

  it('共通テスト型ならマーク式(すべて選択式)。一覧に無い単元を返したら、やり直させる', async () => {
    const t = makeCore({ kinds: { design_test: ['bad_unit', 'ok'] } });
    const p = t.api.createProject({ ...sampleInput, examType: 'kyotsu' });
    const sid = p.subjects[0].id;
    await done(t, t.api.startCreateDiagnostic(p.id, sid));
    const calls = t.fake.calls();
    expect(calls.map((c) => c.kind).slice(0, 2)).toEqual(['design_test', 'design_test']);
    expect(calls[1].prompt).toContain('unitId「zzz」は、入力の units にありません');
    const [test] = t.api.listTests(p.id, sid);
    expect(test.problems.every((q) => q.format === 'choice')).toBe(true);
  });
});

describe('問題冊子・解答用紙の HTML', () => {
  it('問題冊子には問題文・選択肢・図が入り、答えや解説は入らない。解答用紙には設問ごとの欄がある', async () => {
    const t = makeCore({ kinds: { generate_problems: 'with_figure:1' } });
    const p = t.api.createProject(sampleInput);
    const sid = p.subjects[0].id;
    await done(t, t.api.startCreateDiagnostic(p.id, sid));
    const [test] = t.api.listTests(p.id, sid);
    const key = readData(t.core.paths(p.id).subject(sid).test(test.id).answerKeyJson, Files.answerKey);

    const booklet = bookletHtml(test, '数学II・B・C');
    expect(booklet).toContain(KATEX_CSS_PLACEHOLDER);
    expect(booklet).toContain('制限時間: 40 分');
    expect(booklet).toContain('問4');
    expect(booklet).toContain('class="katex"');
    expect(booklet).toContain('①');
    expect(booklet).toContain('data:image/svg+xml');
    expect(booklet).not.toContain(key.items[2].answer); // 記述の模範解答
    expect(booklet).not.toContain('足すと');

    const sheet = answerSheetHtml(test, '数学II・B・C');
    expect(sheet).toContain('解答用紙');
    expect((sheet.match(/class="a-no"/g) ?? []).length).toBe(4);
    expect(sheet).toContain('class="a essay"');
    await expect(t.api.exportTestPdf(p.id, sid, test.id, 'booklet')).rejects.toThrow('アプリの中でだけ');
    expect(() => t.api.revealFile('C:/Windows/system.ini')).toThrow('データフォルダの外');
  });
});
