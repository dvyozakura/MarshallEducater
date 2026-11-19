// 採点。確定した答案を、解答・採点基準に照らして Claude が採点する。ユーザーは結果を上書きでき、上書きは記録する。
import type { MadeBy } from '../shared/engines';
import { existsSync } from 'node:fs';
import { FORMAT_VERSION, GradeOutputSchema, type AnswerKey, type Explanations, type GradeItem, type Grading, type MistakeType, type Reading, type Test } from '../shared/schema';
import { requireConfirmedReading } from './answers';
import type { AppCore } from './app';
import { callClaude } from './claude/task';
import { choiceNumber } from './generate';
import type { JobContext } from './jobs';
import { getProject, getSubject } from './projects';
import { Files, readData, writeData } from './store';
import { getTest, testPaths } from './tests';
import { projectBrief } from './units';
import { isTategaki } from './projects';

/** 上書きを反映した、いまの得点。 */
export function effectiveScore(item: Pick<GradeItem, 'score' | 'override'>): number {
  return item.override ? item.override.score : item.score;
}

export function gradingTotals(grading: Grading): { score: number; max: number } {
  return { score: grading.items.reduce((n, i) => n + effectiveScore(i), 0), max: grading.items.reduce((n, i) => n + i.max, 0) };
}

export function getAnswerKey(core: AppCore, projectId: string, subjectId: string, testId: string): AnswerKey {
  return readData(testPaths(core, projectId, subjectId, testId).answerKeyJson, Files.answerKey);
}

export function getGrading(core: AppCore, projectId: string, subjectId: string, testId: string): Grading | null {
  const f = testPaths(core, projectId, subjectId, testId).gradingJson;
  return existsSync(f) ? readData(f, Files.grading) : null;
}

/** 採点のあとに行う処理(苦手マップの更新など)。ほかのモジュールが登録する。 */
export type GradingHook = (core: AppCore, projectId: string, subjectId: string, test: Test, grading: Grading) => void;
const hooks: GradingHook[] = [];
export function onGraded(hook: GradingHook): void {
  if (!hooks.includes(hook)) hooks.push(hook);
}
function runHooks(core: AppCore, projectId: string, subjectId: string, test: Test, grading: Grading): void {
  for (const h of hooks) h(core, projectId, subjectId, test, grading);
}

/** 確定した答案を採点して grading.json に保存する。 */
export async function gradeTest(core: AppCore, projectId: string, subjectId: string, testId: string, ctx: JobContext): Promise<Grading> {
  const project = getProject(core, projectId);
  const subject = getSubject(project, subjectId);
  const test = getTest(core, projectId, subjectId, testId);
  // 未確定の答案は、ここで断られる
  const reading: Reading = requireConfirmedReading(core, projectId, subjectId, testId);
  const key = getAnswerKey(core, projectId, subjectId, testId);
  const tp = testPaths(core, projectId, subjectId, testId);
  const answerOf = (id: string) => reading.answers.find((a) => a.problemId === id)?.answer.trim() ?? '';
  const keyOf = (id: string) => key.items.find((k) => k.problemId === id);
  const overTime = reading.elapsedSec !== null && reading.elapsedSec >= test.timeLimitMin * 60;

  const toGrade = test.problems.filter((p) => answerOf(p.id) !== '');
  let madeBy: MadeBy | null = null;
  const graded = new Map<string, { score: number; rationale: string; mistake: MistakeType | null; comment: string }>();
  if (toGrade.length > 0) {
    ctx.progress(`${core.who('grade', projectId)} が採点しています(${toGrade.length} 問)`);
    const r = await callClaude({
      projectDir: core.projectDir(projectId),
      kind: 'grade',
      tategaki: isTategaki(core, projectId, subjectId),
      vars: { subjectName: subject.name, testTitle: test.title },
      input: {
        subject: subject.name,
        project: projectBrief(project),
        timeLimitMin: test.timeLimitMin,
        elapsedMin: reading.elapsedSec === null ? null : Math.round(reading.elapsedSec / 60),
        items: toGrade.map((p) => ({
          problemId: p.id,
          number: p.number,
          format: p.format,
          unitName: p.unitName,
          difficulty: p.difficulty,
          points: p.points,
          body: p.body,
          choices: p.choices,
          key: keyOf(p.id)?.answer ?? '',
          rubric: keyOf(p.id)?.rubric ?? '',
          solution: keyOf(p.id)?.solution ?? '',
          answer: answerOf(p.id),
        })),
      },
      schema: GradeOutputSchema,
      env: core.claudeEnv(),
      signal: ctx.signal,
      check: (d) => {
        for (const p of toGrade) {
          const g = d.items.find((i) => i.problemId === p.id);
          if (!g) return `設問 ${p.id}(${p.number})の採点結果がありません。items のすべての設問を採点してください。`;
          if (g.score > p.points) return `設問 ${p.id} の score(${g.score})が配点(${p.points})を超えています。`;
          if (g.score < p.points && !g.mistake) return `設問 ${p.id} は減点があるのに mistake が null です。ミスの種類を1つ付けてください。`;
        }
        return null;
      },
    });
    madeBy = r.madeBy;
    for (const p of toGrade) {
      const g = r.data.items.find((i) => i.problemId === p.id)!;
      let score = g.score;
      let mistake = g.mistake;
      if (p.format === 'choice') {
        // 選択式の正誤は、番号の一致で手元でも確かめる(採点の誤りを防ぐ)
        const correct = choiceNumber(answerOf(p.id)) !== null && choiceNumber(answerOf(p.id)) === choiceNumber(keyOf(p.id)?.answer ?? '');
        score = correct ? p.points : 0;
        mistake = correct ? null : (mistake ?? 'knowledge');
      }
      graded.set(p.id, { score, rationale: g.rationale, mistake: score >= p.points ? null : mistake, comment: g.comment });
    }
  }

  const items: GradeItem[] = test.problems.map((p) => {
    const g = graded.get(p.id) ?? {
      score: 0,
      rationale: '答えが書かれていません。',
      mistake: (overTime ? 'timeout' : 'blank') as MistakeType,
      comment: overTime ? '時間が足りず、手を付けられませんでした。' : '答えが書かれていません。',
    };
    return { problemId: p.id, ...g, max: p.points, unitId: p.unitId, unitName: p.unitName, difficulty: p.difficulty, override: null };
  });
  const grading = writeData(tp.gradingJson, Files.grading, { version: FORMAT_VERSION, testId, gradedAt: new Date().toISOString(), items, overrides: [], madeBy });
  const done: Test = writeData(tp.testJson, Files.test, { ...test, status: 'graded' as const });
  runHooks(core, projectId, subjectId, done, grading);
  return grading;
}

/**
 * 採点結果の上書き(例: 読み取りは合っているが採点が厳しすぎる)。score が null なら上書きを取り消す。
 * 上書きの履歴は grading.json に残す。
 */
export function overrideGrade(core: AppCore, projectId: string, subjectId: string, testId: string, problemId: string, score: number | null, note: string): Grading {
  const tp = testPaths(core, projectId, subjectId, testId);
  const grading = getGrading(core, projectId, subjectId, testId);
  if (!grading) throw new Error('このテストは、まだ採点されていません。');
  const item = grading.items.find((i) => i.problemId === problemId);
  if (!item) throw new Error('その設問は、このテストにありません。');
  if (score !== null && (!Number.isFinite(score) || score < 0 || score > item.max)) throw new Error(`点数は 0〜${item.max} で入れてください。`);
  const at = new Date().toISOString();
  const from = effectiveScore(item);
  const to = score ?? item.score;
  if (from === to && (score === null) === (item.override === null) && (item.override?.note ?? '') === note.trim()) return grading;
  const next: Grading = {
    ...grading,
    items: grading.items.map((i) => (i.problemId === problemId ? { ...i, override: score === null ? null : { score, note: note.trim(), at } } : i)),
    overrides: [...grading.overrides, { at, problemId, from, to, note: score === null ? '上書きを取り消し' : note.trim() }],
  };
  const saved = writeData(tp.gradingJson, Files.grading, next);
  runHooks(core, projectId, subjectId, getTest(core, projectId, subjectId, testId), saved);
  return saved;
}

export interface ResultView {
  test: Test;
  reading: Reading | null;
  grading: Grading | null;
  /** 正解と解き方。採点が済むまでは見せない。 */
  key: AnswerKey | null;
  totals: { score: number; max: number } | null;
  /** 間違えた問題の解説(まだ無ければ null)。 */
  explanations: Explanations | null;
}

export function getResultView(core: AppCore, projectId: string, subjectId: string, testId: string): ResultView {
  const test = getTest(core, projectId, subjectId, testId);
  const tp = testPaths(core, projectId, subjectId, testId);
  const reading = existsSync(tp.readingJson) ? readData(tp.readingJson, Files.reading) : null;
  const grading = getGrading(core, projectId, subjectId, testId);
  const explanations = grading && existsSync(tp.explanationsJson) ? readData(tp.explanationsJson, Files.explanations) : null;
  return { test, reading, grading, key: grading ? getAnswerKey(core, projectId, subjectId, testId) : null, totals: grading ? gradingTotals(grading) : null, explanations };
}
