import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../../src/core/claude/prompts';
import { checkGenerated, choiceNumber, generateVerified, normalizeAnswer, type ProblemRequest } from '../../src/core/generate';
import type { JobContext } from '../../src/core/jobs';
import { Files, readData } from '../../src/core/store';
import { createTest, getVerify, listTests, verifyTotals, type TestPlan } from '../../src/core/tests';
import { GenerateOutputSchema, JudgeOutputSchema, SolveOutputSchema, type GeneratedProblem } from '../../src/shared/schema';
import { makeCore, sampleInput } from './helpers';

export const testCtx = (): JobContext & { log: string[] } => {
  const log: string[] = [];
  return { signal: new AbortController().signal, progress: (t) => log.push(t), log };
};

const REQUESTS: ProblemRequest[] = [
  { unitId: 'u01-01', difficulty: 'easy', format: 'choice', origin: 'diagnostic' },
  { unitId: 'u01-02', difficulty: 'standard', format: 'short', origin: 'diagnostic' },
  { unitId: 'u02-01', difficulty: 'target', format: 'essay', origin: 'diagnostic' },
];

function setup(control: unknown = {}) {
  const t = makeCore(control);
  const p = t.api.createProject(sampleInput);
  const sid = p.subjects[0].id;
  const run = (requests = REQUESTS) => generateVerified(t.core, { projectId: p.id, subjectId: sid, purpose: '実力診断テスト', requests }, testCtx());
  const kinds = () => t.fake.calls().map((c) => c.kind);
  return { t, p, sid, run, kinds };
}

describe('答えの照らし合わせ(手元でできる分)', () => {
  it('空白・全角・$ 記号の違いはならす', () => {
    expect(normalizeAnswer(' $x = 2,\\ 3$ ')).toBe(normalizeAnswer('x=2,3'));
    expect(normalizeAnswer('25。')).toBe('25');
    expect(normalizeAnswer('ABC')).toBe('abc');
    expect(normalizeAnswer('24')).not.toBe(normalizeAnswer('25'));
    expect(choiceNumber('③')).toBe(3);
    expect(choiceNumber('選択肢 2')).toBe(2);
    expect(choiceNumber('ア')).toBeNull();
  });

  it('作った問題の検査: 数・形式・選択肢・正解の番号', () => {
    const g = (o: Partial<GeneratedProblem>): GeneratedProblem => GenerateOutputSchema.parse({ problems: [{ unitId: 'u', difficulty: 'easy', format: 'short', body: 'b', points: 10, answer: '1', ...o }] }).problems[0];
    const req = (format: ProblemRequest['format']): ProblemRequest => ({ unitId: 'u', difficulty: 'easy', format, origin: 'practice' });
    expect(checkGenerated([g({})], [req('short')])).toBeNull();
    expect(checkGenerated([], [req('short')])).toContain('数が注文と違います');
    expect(checkGenerated([g({})], [req('essay')])).toContain('format');
    expect(checkGenerated([g({ format: 'choice', choices: ['a'] })], [req('choice')])).toContain('2つ以上');
    expect(checkGenerated([g({ format: 'choice', choices: ['a', 'b'], answer: '3' })], [req('choice')])).toContain('番号');
    expect(checkGenerated([g({ format: 'choice', choices: ['a', 'b'], answer: '2' })], [req('choice')])).toBeNull();
  });
});

describe('プロンプトと型(作成・解き直し・照らし合わせ)', () => {
  it('作成のプロンプトに用途と決まりが入り、解き直しのプロンプトには答えの項目が無い', () => {
    const gen = buildPrompt({ kind: 'generate_problems', vars: { subjectName: '数学', purpose: '実力診断テスト' }, inputFile: 'in.json', outputFile: 'out.json', schema: GenerateOutputSchema });
    expect(gen).toContain('実力診断テスト');
    for (const key of ['"body"', '"choices"', '"answer"', '"rubric"', '"solution"', '"figureSvg"', '"points"']) expect(gen, key).toContain(key);
    const solve = buildPrompt({ kind: 'solve_problems', vars: { subjectName: '数学' }, inputFile: 'in.json', outputFile: 'out.json', schema: SolveOutputSchema });
    expect(solve).toContain('解答や解説は渡していません');
    expect(solve).toContain('"issue"');
    expect(solve).not.toContain('"rubric"');
    const judge = buildPrompt({ kind: 'judge_answers', vars: { subjectName: '数学' }, inputFile: 'in.json', outputFile: 'out.json', schema: JudgeOutputSchema });
    expect(judge).toContain('"match"');
    expect(GenerateOutputSchema.safeParse({ problems: [{ unitId: 'u', difficulty: 'hard', format: 'short', body: 'b', points: 10, answer: '1' }] }).success).toBe(false);
    expect(GenerateOutputSchema.safeParse({ problems: [{ unitId: 'u', difficulty: 'easy', format: 'short', body: 'b', points: 10, answer: '' }] }).success).toBe(false);
  });
});

describe('問題の作成と検算(偽 Claude)', () => {
  it('一致: そのまま採用。解き直しには答えを渡さない。記述は照らし合わせの呼び出しで判定する', async () => {
    const { t, run, kinds } = setup();
    const r = await run();
    expect(r.counts).toEqual({ adopted: 3, regenerated: 0, discarded: 0 });
    expect(r.problems.map((x) => x.slot)).toEqual([0, 1, 2]);
    expect(r.problems.map((x) => x.problem.format)).toEqual(['choice', 'short', 'essay']);
    expect(r.problems[0].problem.choices).toHaveLength(4);
    expect(r.problems[1].problem.choices).toEqual([]);
    expect(r.problems[0].unitName).toContain('>');
    expect(kinds()).toEqual(['generate_problems', 'solve_problems', 'judge_answers']);
    // 解き直しの入力(記録に残るプロンプト)に、答えは入っていない
    const solveCall = t.fake.calls()[1];
    expect(solveCall.prompt).not.toContain(r.problems[1].problem.solution);
  });

  it('短答で書き方だけ違う答えは、照らし合わせで一致と判定される', async () => {
    const { run, kinds } = setup({ kinds: { solve_problems: 'reworded' } });
    const r = await run([REQUESTS[1]]);
    expect(r.counts).toEqual({ adopted: 1, regenerated: 0, discarded: 0 });
    expect(kinds()).toEqual(['generate_problems', 'solve_problems', 'judge_answers']);
  });

  it('不一致 → 作り直しで一致: 理由を添えて、その問題だけ1回作り直す', async () => {
    const { run, kinds } = setup({ kinds: { solve_problems: ['wrong:2', 'ok'] } });
    const r = await run();
    expect(r.counts).toEqual({ adopted: 2, regenerated: 1, discarded: 0 });
    expect(r.problems).toHaveLength(3);
    // 2問目だけが作り直された(偽 Claude は、作り直しでは数を変える)
    expect(r.problems[0].problem.body).toContain('$13 + 7$');
    expect(r.problems[1].problem.body).toContain('$113 + 7$');
    const ev = r.events.find((e) => e.outcome === 'regenerated')!;
    expect(ev.slot).toBe(1);
    expect(ev.reason).toContain('合わない');
    expect(kinds()).toEqual(['generate_problems', 'solve_problems', 'judge_answers', 'generate_problems', 'solve_problems']);
  });

  it('解き直しで「条件不足」と言われた問題も、作り直しになる', async () => {
    const { run } = setup({ kinds: { solve_problems: ['issue:1', 'ok'] } });
    const r = await run();
    expect(r.counts).toEqual({ adopted: 2, regenerated: 1, discarded: 0 });
    expect(r.events.find((e) => e.outcome === 'regenerated')!.reason).toContain('条件が足りず');
  });

  it('不一致 → 作り直しても不一致 → 破棄して、別の問題に差し替える', async () => {
    const { run, kinds } = setup({ kinds: { solve_problems: ['wrong:1', 'wrong:1', 'ok'] } });
    const r = await run();
    expect(r.counts).toEqual({ adopted: 3, regenerated: 0, discarded: 1 });
    expect(r.problems).toHaveLength(3);
    expect(r.events.filter((e) => e.slot === 0).map((e) => e.outcome)).toEqual(['discarded', 'adopted']);
    expect(r.events.find((e) => e.outcome === 'discarded')!.reason).toContain('作り直しても');
    expect(kinds().filter((k) => k === 'generate_problems')).toHaveLength(3);
  });

  it('代わりの問題も駄目なら、その注文はあきらめる(残りは採用)。全部駄目ならテストは作らない', async () => {
    const { t, p, sid, run } = setup({ kinds: { solve_problems: ['wrong:1', 'wrong:1', 'wrong:1'] } });
    const r = await run();
    expect(r.counts).toEqual({ adopted: 2, regenerated: 0, discarded: 2 });
    expect(r.problems.map((x) => x.slot)).toEqual([1, 2]);

    t.fake.set({ kinds: { solve_problems: 'wrong' } });
    const plan: TestPlan = { kind: 'practice', title: '演習', timeLimitMin: 10, instructions: '', purpose: '演習', requests: [REQUESTS[0]] };
    await expect(createTest(t.core, p.id, sid, plan, testCtx())).rejects.toThrow('検算に通る問題を1つも作れませんでした');
    expect(listTests(t.core, p.id, sid)).toHaveLength(0);
  });

  it('図(SVG)が崩れている問題は、図なしの問題に差し替える。まともな図は残す', async () => {
    const a = setup({ kinds: { generate_problems: ['bad_svg:1', 'with_figure'] } });
    const r = await a.run();
    expect(r.counts).toEqual({ adopted: 2, regenerated: 1, discarded: 0 });
    expect(r.events.find((e) => e.outcome === 'regenerated')!.reason).toContain('図');
    expect(r.problems[0].problem.figureSvg).toBeNull(); // 作り直しは「図なしで」と注文される

    const b = setup({ kinds: { generate_problems: 'with_figure:2' } });
    const r2 = await b.run();
    expect(r2.problems[1].problem.figureSvg).toContain('<svg');
    expect(r2.problems[0].problem.figureSvg).toBeNull();
  });
});

describe('テストとして保存(検算の結果の記録)', () => {
  it('test.json・answer_key.json・verify.json ができ、問題文の側には答えが入らない', async () => {
    const { t, p, sid } = setup({ kinds: { solve_problems: ['wrong:1,2', 'wrong:1', 'ok'] } });
    const ctx = testCtx();
    const plan: TestPlan = { kind: 'practice', title: '演習テスト', timeLimitMin: 20, instructions: '落ち着いて解く', purpose: '演習', requests: REQUESTS };
    const test = await createTest(t.core, p.id, sid, plan, ctx);
    expect(test).toMatchObject({ kind: 'practice', title: '演習テスト', timeLimitMin: 20, status: 'ready', subjectId: sid });
    expect(test.problems.map((q) => q.id)).toEqual(['p01', 'p02', 'p03']);
    expect(test.problems.map((q) => q.number)).toEqual(['問1', '問2', '問3']);
    expect(test.problems[0]).toMatchObject({ unitId: 'u01-01', difficulty: 'easy', origin: 'diagnostic' });
    expect(JSON.stringify(test)).not.toContain('solution');

    const tp = t.core.paths(p.id).subject(sid).test(test.id);
    const key = readData(tp.answerKeyJson, Files.answerKey);
    expect(key.items.map((k) => k.problemId)).toEqual(['p01', 'p02', 'p03']);
    expect(key.items[0].answer).toBe('2');

    // 1問目: 作り直しても駄目 → 破棄 → 代わりを採用。2問目: 作り直しで一致。3問目: そのまま採用
    const verify = getVerify(t.core, p.id, sid, test.id)!;
    expect(verify.counts).toEqual({ adopted: 2, regenerated: 1, discarded: 1 });
    expect(verify.records.map((r) => `${r.outcome}:${r.problemId}`).sort()).toEqual(['adopted:p01', 'adopted:p03', 'discarded:null', 'regenerated:p02']);
    expect(existsSync(tp.verifyJson)).toBe(true);
    expect(verifyTotals(t.core)).toEqual({ adopted: 2, regenerated: 1, discarded: 1, tests: 1 });
    expect(listTests(t.core, p.id, sid).map((x) => x.id)).toEqual([test.id]);
    // 何を待っているかが伝わる
    expect(ctx.log.join(' / ')).toMatch(/問題を作っています.*検算しています.*作り直しています.*代わりを作っています/);
  });
});
