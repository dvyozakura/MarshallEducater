// テスト(診断・今日の課題・模擬試験・演習)の作成と一覧。問題は generate.ts の仕組みで作り、検算の結果を verify.json に残す。
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FORMAT_VERSION, type AnswerKey, type Problem, type Test, type TestKind, type Verify, type VerifyOutcome } from '../shared/schema';
import type { AppCore } from './app';
import { newId } from './fsutil';
import { generateVerified, type ProblemRequest } from './generate';
import type { JobContext } from './jobs';
import { listProjects } from './projects';
import { Files, readData, writeData } from './store';

export interface TestPlan {
  kind: TestKind;
  title: string;
  timeLimitMin: number;
  instructions: string;
  /** 用途(問題づくりのプロンプトに入れる)。 */
  purpose: string;
  requests: ProblemRequest[];
  /** 今日の課題の場合の日付。 */
  date?: string | null;
}

function checkTestId(id: string): void {
  if (!id || /[\\/]|^\.+$/.test(id)) throw new Error('テストの指定が正しくありません');
}

export function testPaths(core: AppCore, projectId: string, subjectId: string, testId: string) {
  checkTestId(testId);
  return core.paths(projectId).subject(subjectId).test(testId);
}

/** 問題を作って検算し、テストとして保存する(test.json、answer_key.json、verify.json)。 */
export async function createTest(core: AppCore, projectId: string, subjectId: string, plan: TestPlan, ctx: JobContext): Promise<Test> {
  const result = await generateVerified(core, { projectId, subjectId, purpose: plan.purpose, requests: plan.requests }, ctx);
  if (result.problems.length === 0) {
    throw new Error(`検算に通る問題を1つも作れませんでした(作り直し ${result.counts.regenerated}、破棄 ${result.counts.discarded})。もう一度試してください。`);
  }
  const testId = newId('test');
  const tp = testPaths(core, projectId, subjectId, testId);
  const idOf = (i: number) => `p${String(i + 1).padStart(2, '0')}`;
  const problems: Problem[] = result.problems.map((v, i) => ({
    id: idOf(i),
    number: `問${i + 1}`,
    unitId: v.problem.unitId,
    unitName: v.unitName,
    difficulty: v.problem.difficulty,
    format: v.problem.format,
    body: v.problem.body,
    choices: v.problem.choices,
    points: v.problem.points,
    figureSvg: v.problem.figureSvg,
    origin: v.request.origin,
  }));
  const key: AnswerKey = {
    version: FORMAT_VERSION,
    testId,
    items: result.problems.map((v, i) => ({ problemId: idOf(i), answer: v.problem.answer, rubric: v.problem.rubric, solution: v.problem.solution })),
  };
  const slotToId = new Map(result.problems.map((v, i) => [v.slot, idOf(i)]));
  const verify: Verify = {
    version: FORMAT_VERSION,
    testId,
    records: result.events.map((e) => ({ problemId: e.outcome === 'discarded' ? null : (slotToId.get(e.slot) ?? null), unitId: e.unitId, outcome: e.outcome, reason: e.reason })),
    counts: result.counts,
  };
  // 答えと検算の記録を先に書き、最後に test.json を書く(test.json があれば、そろっている)
  writeData(tp.answerKeyJson, Files.answerKey, key);
  writeData(tp.verifyJson, Files.verify, verify);
  return writeData(tp.testJson, Files.test, {
    version: FORMAT_VERSION,
    id: testId,
    subjectId,
    kind: plan.kind,
    title: plan.title,
    timeLimitMin: Math.max(1, Math.round(plan.timeLimitMin)),
    instructions: plan.instructions,
    problems,
    createdAt: new Date().toISOString(),
    date: plan.date ?? null,
    status: 'ready',
  });
}

export function getTest(core: AppCore, projectId: string, subjectId: string, testId: string): Test {
  return readData(testPaths(core, projectId, subjectId, testId).testJson, Files.test);
}

export function getVerify(core: AppCore, projectId: string, subjectId: string, testId: string): Verify | null {
  const f = testPaths(core, projectId, subjectId, testId).verifyJson;
  return existsSync(f) ? readData(f, Files.verify) : null;
}

/** 科目のテストの一覧(新しい順)。壊れたものは出さない。 */
export function listTests(core: AppCore, projectId: string, subjectId: string): Test[] {
  const dir = core.paths(projectId).subject(subjectId).testsDir;
  if (!existsSync(dir)) return [];
  const out: Test[] = [];
  for (const name of readdirSync(dir)) {
    const f = join(dir, name, 'test.json');
    if (!existsSync(f)) continue;
    try {
      out.push(readData(f, Files.test));
    } catch {
      /* 壊れたテストは一覧に出さない */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 検算の結果の合計(設定画面の「品質」欄)。全プロジェクト・全科目のテストを数える。 */
export function verifyTotals(core: AppCore): Record<VerifyOutcome, number> & { tests: number } {
  const total = { adopted: 0, regenerated: 0, discarded: 0, tests: 0 };
  for (const p of listProjects(core).projects) {
    for (const s of p.subjects) {
      for (const t of listTests(core, p.id, s.id)) {
        const v = getVerify(core, p.id, s.id, t.id);
        if (!v) continue;
        total.tests++;
        total.adopted += v.counts.adopted;
        total.regenerated += v.counts.regenerated;
        total.discarded += v.counts.discarded;
      }
    }
  }
  return total;
}
