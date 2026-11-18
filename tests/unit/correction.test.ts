import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requireConfirmedReading } from '../../src/core/answers';
import { buildPrompt } from '../../src/core/claude/prompts';
import { charDiff, listConfirmedSources, requireConfirmedProblems } from '../../src/core/correction';
import { modeInstructions } from '../../src/core/reading';
import { sourcePaths } from '../../src/core/sources';
import { Files, readData, writeData } from '../../src/core/store';
import { FORMAT_VERSION, RereadOutputSchema, type Test } from '../../src/shared/schema';
import { done, importFake, makeCore, sampleInput, type TestCore } from './helpers';

async function setup(pages = 2, control: unknown = {}) {
  const t = makeCore(control);
  const p = t.api.createProject(sampleInput);
  const sid = p.subjects[0].id;
  const sourceId = importFake(t, p.id, sid, pages);
  await done(t, t.api.startReadSource(p.id, sid, sourceId));
  const ids = [p.id, sid, sourceId] as const;
  return { t, p, sid, sourceId, ids };
}

/** 手でテストを1つ置く(テスト作成の仕組みを通さない最小のもの)。 */
export function putTest(t: TestCore, projectId: string, subjectId: string, testId = 'test-1'): Test {
  const tp = t.core.paths(projectId).subject(subjectId).test(testId);
  const problem = (n: number) => ({
    id: `p${n}`,
    number: `問${n}`,
    unitId: 'u01-01',
    unitName: '単元',
    difficulty: 'standard' as const,
    format: 'short' as const,
    body: `問題 ${n}`,
    choices: [],
    points: 10,
    figureSvg: null,
    origin: 'diagnostic' as const,
  });
  return writeData(tp.testJson, Files.test, {
    version: FORMAT_VERSION,
    id: testId,
    subjectId,
    kind: 'diagnostic',
    title: 'ダミーのテスト',
    timeLimitMin: 30,
    instructions: '',
    problems: [problem(1), problem(2)],
    createdAt: new Date().toISOString(),
    date: null,
    status: 'ready',
  });
}

describe('直した文字数の目安', () => {
  it('置き換え・追加・削除を数え、並べ替えだけなら 0', () => {
    expect(charDiff('abc', 'abc')).toBe(0);
    expect(charDiff('abc', 'abd')).toBe(1);
    expect(charDiff('abc', 'abcde')).toBe(2);
    expect(charDiff('abcde', 'ab')).toBe(3);
    expect(charDiff('abc', 'cba')).toBe(0);
  });
});

describe('補正(編集・分割・結合・並べ替え・削除)', () => {
  it('編集は変わった項目だけ履歴に残り、補正率が出る。変えていなければ何も残らない', async () => {
    const { t, ids } = await setup();
    const v0 = t.api.getCorrectionView(...ids);
    expect(v0.extracted!.problems).toHaveLength(4);
    expect(v0.pages).toEqual([1, 2]);
    expect(v0.units.length).toBeGreaterThan(3);
    expect(v0.targets).toBeNull();
    const q = v0.extracted!.problems[0];

    t.api.updateProblem(...ids, q.id, { body: q.body, number: q.number });
    expect(t.api.getCorrections(...ids)!.entries).toHaveLength(0);

    const v1 = t.api.updateProblem(...ids, q.id, { body: q.body.replace('2次方程式', '二次方程式'), points: 15 });
    expect(v1.extracted!.problems[0]).toMatchObject({ points: 15, confirmed: false });
    expect(v1.extracted!.problems[0].body).toContain('二次方程式');
    expect(v1.stats.edits).toBe(1);
    expect(v1.stats.changedChars).toBe(1);
    expect(v1.stats.originalChars).toBeGreaterThan(50);
    const entry = t.api.getCorrections(...ids)!.entries[0];
    expect(entry.action).toBe('edit');
    expect(Object.keys(JSON.parse(entry.before!)).sort()).toEqual(['body', 'points']);
    expect(JSON.parse(entry.after!).points).toBe(15);
    // Claude が読んだままの控えは変わらない
    const paths = sourcePaths(t.core, ...ids);
    expect(readData(paths.extractedOriginalJson, Files.extracted).problems[0].points).toBe(10);
  });

  it('分割 → 結合で元に戻る。並べ替えと削除', async () => {
    const { t, ids } = await setup();
    const q = t.api.getCorrectionView(...ids).extracted!.problems[0];
    const at = q.body.indexOf('2次方程式');
    const v1 = t.api.splitProblem(...ids, q.id, at);
    expect(v1.extracted!.problems).toHaveLength(5);
    const [a, b] = v1.extracted!.problems;
    expect(a.body).toBe(q.body.slice(0, at).trimEnd());
    expect(b.body).toBe(q.body.slice(at));
    expect(b.id).toBe('q005');
    expect(b.number).toContain('続き');
    expect(a.figures).toHaveLength(1);
    expect(b.figures).toHaveLength(0);
    expect(() => t.api.splitProblem(...ids, q.id, 0)).toThrow('途中');

    const v2 = t.api.mergeWithNext(...ids, a.id);
    expect(v2.extracted!.problems).toHaveLength(4);
    expect(v2.extracted!.problems[0].body).toBe(`${a.body}\n${b.body}`);
    expect(v2.extracted!.problems[0].points).toBe(10);
    // 分けてつなげ直しただけなら、直した文字数は(改行1つを除いて)増えない
    expect(v2.stats.changedChars).toBeLessThanOrEqual(1);

    const idsBefore = v2.extracted!.problems.map((x) => x.id);
    const v3 = t.api.moveProblem(...ids, idsBefore[0], 1);
    expect(v3.extracted!.problems.map((x) => x.id)).toEqual([idsBefore[1], idsBefore[0], idsBefore[2], idsBefore[3]]);
    const v4 = t.api.moveProblem(...ids, idsBefore[1], -1); // 先頭をさらに前へ → 何も起きない
    expect(v4.extracted!.problems.map((x) => x.id)).toEqual(v3.extracted!.problems.map((x) => x.id));

    const paths = sourcePaths(t.core, ...ids);
    const figFile = join(paths.root, v4.extracted!.problems[1].figures[0].image!);
    expect(existsSync(figFile)).toBe(true);
    const v5 = t.api.deleteProblem(...ids, idsBefore[0]);
    expect(v5.extracted!.problems.map((x) => x.id)).toEqual([idsBefore[1], idsBefore[2], idsBefore[3]]);
    expect(existsSync(figFile)).toBe(false);
    expect(() => t.api.mergeWithNext(...ids, idsBefore[3])).toThrow('最後の問題');
    expect(() => t.api.updateProblem(...ids, idsBefore[0], { body: 'x' })).toThrow('見つかりません');
    // 消したあとに分けても、ID は使い回さない
    const v6 = t.api.splitProblem(...ids, idsBefore[1], 5);
    expect(v6.extracted!.problems.map((x) => x.id)).toContain('q006');
    expect(t.api.getCorrections(...ids)!.entries.map((e) => e.action)).toEqual(['split', 'merge', 'reorder', 'delete', 'split']);
  });

  it('自信がない箇所を「確かめた」にできる', async () => {
    const { t, ids } = await setup(1);
    const q = t.api.getCorrectionView(...ids).extracted!.problems[1];
    expect(q.uncertain).toHaveLength(1);
    const v = t.api.resolveUncertain(...ids, q.id, 0);
    expect(v.extracted!.problems[1].uncertain).toHaveLength(0);
    expect(v.stats.changedChars).toBe(0);
  });

  it('図の切り出し範囲の修正・追加・削除', async () => {
    const { t, ids } = await setup(1);
    const paths = sourcePaths(t.core, ...ids);
    const q = t.api.getCorrectionView(...ids).extracted!.problems[0];
    const fig = q.figures[0];
    const oldFile = join(paths.root, fig.image!);
    await new Promise((r) => setTimeout(r, 5));
    const v1 = t.api.saveFigure(...ids, q.id, { id: fig.id, page: 1, bbox: { x: 0.2, y: 0.4, w: 0.5, h: 0.4 } });
    const f1 = v1.extracted!.problems[0].figures[0];
    expect(f1.bbox).toEqual({ x: 0.2, y: 0.4, w: 0.5, h: 0.4 });
    expect(f1.description).toBe(fig.description);
    expect(f1.image).not.toBe(fig.image);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(join(paths.root, f1.image!))).toBe(true);
    expect(t.api.readFigureImage(...ids, f1.image!).length).toBeGreaterThan(0);
    expect(() => t.api.readFigureImage(...ids, '../source.json')).toThrow();

    // 説明だけ直す → 画像はそのまま
    const v2 = t.api.saveFigure(...ids, q.id, { id: fig.id, page: 1, bbox: f1.bbox, description: '直した説明' });
    expect(v2.extracted!.problems[0].figures[0]).toMatchObject({ image: f1.image, description: '直した説明' });

    // 追加と削除
    const v3 = t.api.saveFigure(...ids, q.id, { page: 1, bbox: { x: 0, y: 0, w: 0.3, h: 0.3 }, description: '足した図' });
    expect(v3.extracted!.problems[0].figures.map((f) => f.id)).toEqual(['q001-f1', 'q001-f2']);
    expect(() => t.api.saveFigure(...ids, q.id, { page: 1, bbox: { x: 0, y: 0, w: 0.001, h: 0.3 } })).toThrow('小さすぎ');
    expect(() => t.api.saveFigure(...ids, q.id, { page: 9, bbox: { x: 0, y: 0, w: 0.3, h: 0.3 } })).toThrow('ページ 9');
    const v4 = t.api.deleteFigure(...ids, q.id, 'q001-f1');
    expect(v4.extracted!.problems[0].figures.map((f) => f.id)).toEqual(['q001-f2']);
    expect(existsSync(join(paths.root, f1.image!))).toBe(false);
  });
});

describe('ヒント付きの部分再読み取り', () => {
  it('プロンプトにヒントと対象が入り、選んだ1問だけが置き換わる', async () => {
    const { t, ids } = await setup(1);
    const before = t.api.getCorrectionView(...ids).extracted!.problems;
    const target = before[1];
    const job = await done(t, t.api.startRereadProblem(...ids, target.id, '積分の上端は 1 です'));
    expect(job.title).toContain('読み直し');
    const call = t.fake.calls().at(-1)!;
    expect(call.kind).toBe('reread_problem');
    expect(call.prompt).toContain('積分の上端は 1 です');
    expect(call.prompt).toContain('1つの問題だけ');

    const after = t.api.getCorrectionView(...ids).extracted!.problems;
    expect(after[0]).toEqual(before[0]);
    expect(after[1].body).toContain('(読み直し: 積分の上端は 1 です)');
    expect(after[1].uncertain).toEqual([]);
    expect(after[1].choices).toEqual(target.choices);
    const entry = t.api.getCorrections(...ids)!.entries.at(-1)!;
    expect(entry.action).toBe('reread');
    expect(JSON.parse(entry.before!).hint).toBe('積分の上端は 1 です');
  });

  it('プロンプトと型', () => {
    const vars = { modeLabel: '答案', subjectName: '数学', title: 'ダミー', kindLabel: '答案', modeInstructions: modeInstructions('answers'), hint: '2行目は 7 ではなく 1' };
    const p = buildPrompt({ kind: 'reread_problem', vars, inputFile: 'in.json', outputFile: 'out.json', schema: RereadOutputSchema });
    expect(p).toContain('2行目は 7 ではなく 1');
    expect(p).toContain('ME_PROMPT_KIND: reread_problem');
    expect(p).toContain('"problem"');
    expect(RereadOutputSchema.safeParse({ problem: { number: '1', body: 'x' } }).success).toBe(true);
    expect(RereadOutputSchema.safeParse({ problems: [] }).success).toBe(false);
  });
});

describe('確定(未確定の資料は後の処理に使われない)', () => {
  it('資料を確定するまで、後の処理の入口は断る。直すと確定が外れる', async () => {
    const { t, p, sid, sourceId, ids } = await setup(1);
    expect(() => requireConfirmedProblems(t.core, ...ids)).toThrow('まだ確定されていません');
    expect(listConfirmedSources(t.core, p.id, sid)).toHaveLength(0);

    // 問題ごとの確定だけでは、資料は未確定のまま
    const q = t.api.getCorrectionView(...ids).extracted!.problems[0];
    const v1 = t.api.confirmProblem(...ids, q.id, true);
    expect(v1.extracted!.problems[0].confirmed).toBe(true);
    expect(v1.source.status).toBe('read');
    expect(() => requireConfirmedProblems(t.core, ...ids)).toThrow();

    const v2 = t.api.confirmSource(...ids);
    expect(v2.source.status).toBe('confirmed');
    expect(v2.extracted!.confirmedAt).toBeTruthy();
    expect(v2.extracted!.problems.every((x) => x.confirmed)).toBe(true);
    expect(requireConfirmedProblems(t.core, ...ids)).toHaveLength(2);
    expect(listConfirmedSources(t.core, p.id, sid, 'past_exam').map((s) => s.source.id)).toEqual([sourceId]);
    expect(listConfirmedSources(t.core, p.id, sid, 'workbook')).toHaveLength(0);

    // 確定のあとで直す → 資料もその問題も未確定に戻り、後の処理には流れない
    const v3 = t.api.updateProblem(...ids, q.id, { body: '直した本文' });
    expect(v3.source.status).toBe('read');
    expect(v3.extracted!.confirmedAt).toBeNull();
    expect(v3.extracted!.problems.map((x) => x.confirmed)).toEqual([false, true]);
    expect(() => requireConfirmedProblems(t.core, ...ids)).toThrow();
    expect(listConfirmedSources(t.core, p.id, sid)).toHaveLength(0);

    t.api.confirmSource(...ids);
    expect(t.api.unconfirmSource(...ids).source.status).toBe('read');
    expect(t.api.getCorrections(...ids)!.entries.map((e) => e.action)).toEqual(['confirm', 'confirm_all', 'edit', 'confirm_all', 'unconfirm']);

    // 別のまだ読み取っていない資料は、確定できない
    const other = importFake(t, p.id, sid, 1, 'past_exam', '未読み取り');
    expect(() => t.api.confirmSource(p.id, sid, other)).toThrow('まだ読み取られていません');
    expect(t.api.getCorrectionView(p.id, sid, other).extracted).toBeNull();
  });

  it('答案: 確定すると採点用の答案(reading.json)になり、確定を外すと採点に流れない', async () => {
    const t = makeCore();
    const p = t.api.createProject(sampleInput);
    const sid = p.subjects[0].id;
    putTest(t, p.id, sid);
    const sourceId = importFake(t, p.id, sid, 1, 'answer', '答案', 'test-1');
    expect(sourceId).toBe('sub-test-1');
    await done(t, t.api.startReadSource(p.id, sid, sourceId));
    const ids = [p.id, sid, sourceId] as const;
    const v = t.api.getCorrectionView(...ids);
    expect(v.targets!.map((x) => x.number)).toEqual(['問1', '問2']);
    expect(v.extracted!.problems.map((x) => x.target)).toEqual(['問1', '問2']);
    expect(() => requireConfirmedReading(t.core, p.id, sid, 'test-1')).toThrow('まだ出されていません');

    // 対応する設問が決まっていない答案があると、確定できない
    t.api.updateProblem(...ids, v.extracted!.problems[0].id, { target: null });
    expect(() => t.api.confirmSource(...ids)).toThrow('どの設問への解答か');
    expect(t.api.getSource(...ids).status).toBe('read');
    t.api.updateProblem(...ids, v.extracted!.problems[0].id, { target: '問2', body: '前半' });
    t.api.updateProblem(...ids, v.extracted!.problems[1].id, { body: '後半' });

    t.api.confirmSource(...ids);
    const reading = requireConfirmedReading(t.core, p.id, sid, 'test-1');
    expect(reading).toMatchObject({ method: 'scan', confirmed: true });
    expect(reading.answers).toEqual([
      { problemId: 'p1', answer: '' },
      { problemId: 'p2', answer: '前半\n後半' },
    ]);
    const tp = t.core.paths(p.id).subject(sid).test('test-1');
    expect(readData(tp.testJson, Files.test).status).toBe('submitted');

    // 確定のあとで直すと、採点には流れない
    t.api.updateProblem(...ids, v.extracted!.problems[1].id, { body: '直した' });
    expect(() => requireConfirmedReading(t.core, p.id, sid, 'test-1')).toThrow('まだ確定されていません');
    expect(readData(tp.testJson, Files.test).status).toBe('reading');
  });
});
