// 答案(reading.json)の読み書き。採点に使えるのは「確定した答案」だけ。
import { existsSync, rmSync } from 'node:fs';
import { FORMAT_VERSION, type Draft, type Reading, type Test } from '../shared/schema';
import type { AppCore } from './app';
import { Files, readData, writeData } from './store';
import { getTest, testPaths } from './tests';

export function getReading(core: AppCore, projectId: string, subjectId: string, testId: string): Reading | null {
  const tp = testPaths(core, projectId, subjectId, testId);
  return existsSync(tp.readingJson) ? readData(tp.readingJson, Files.reading) : null;
}

/** 採点など後の処理の入口。確定した答案が無ければ、理由を添えて断る。 */
export function requireConfirmedReading(core: AppCore, projectId: string, subjectId: string, testId: string): Reading {
  const reading = getReading(core, projectId, subjectId, testId);
  if (!reading) throw new Error('このテストの答案がまだ出されていません。');
  if (!reading.confirmed) throw new Error('答案の読み取り結果がまだ確定されていません。補正画面で確かめて「確定」してください。');
  return reading;
}

export interface TakeView {
  test: Test;
  draft: Draft | null;
  reading: Reading | null;
}

/** 解く画面に必要なもの(問題・途中の控え・出した答案)。答えは含めない。 */
export function getTakeView(core: AppCore, projectId: string, subjectId: string, testId: string): TakeView {
  const tp = testPaths(core, projectId, subjectId, testId);
  let draft: Draft | null = null;
  try {
    if (existsSync(tp.draftJson)) draft = readData(tp.draftJson, Files.draft);
  } catch {
    /* 控えが壊れていたら、最初から */
  }
  return { test: getTest(core, projectId, subjectId, testId), draft, reading: getReading(core, projectId, subjectId, testId) };
}

function cleanAnswers(test: Test, answers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of test.problems) {
    const a = answers[p.id];
    if (typeof a === 'string' && a.trim()) out[p.id] = a.slice(0, 20000);
  }
  return out;
}

/** 途中の控えを保存する(アプリ内で解いているとき)。 */
export function saveDraft(core: AppCore, projectId: string, subjectId: string, testId: string, input: { answers: Record<string, string>; elapsedSec: number; extended?: boolean }): Draft {
  const tp = testPaths(core, projectId, subjectId, testId);
  const test = getTest(core, projectId, subjectId, testId);
  if (test.status !== 'ready') throw new Error('このテストは、もう提出されています。');
  const prev = existsSync(tp.draftJson) ? readData(tp.draftJson, Files.draft) : null;
  return writeData(tp.draftJson, Files.draft, {
    version: FORMAT_VERSION,
    testId,
    answers: cleanAnswers(test, input.answers),
    startedAt: prev?.startedAt ?? new Date().toISOString(),
    elapsedSec: Math.max(0, Math.round(input.elapsedSec)),
    extended: input.extended ?? prev?.extended ?? false,
  });
}

/** アプリ内で入力した答案を提出する。自分で入力したものなので、そのまま確定になる。 */
export function submitAnswers(core: AppCore, projectId: string, subjectId: string, testId: string, input: { answers: Record<string, string>; elapsedSec: number | null }): Reading {
  const tp = testPaths(core, projectId, subjectId, testId);
  const test = getTest(core, projectId, subjectId, testId);
  if (test.status === 'graded') throw new Error('このテストは採点済みです。出し直しはできません。');
  const unknown = Object.keys(input.answers).filter((id) => !test.problems.some((p) => p.id === id));
  if (unknown.length) throw new Error(`このテストに無い設問への解答があります(${unknown.join('、')})`);
  const answers = cleanAnswers(test, input.answers);
  const reading = writeData(tp.readingJson, Files.reading, {
    version: FORMAT_VERSION,
    testId,
    method: 'inapp' as const,
    answers: test.problems.map((p) => ({ problemId: p.id, answer: (answers[p.id] ?? '').trim() })),
    confirmed: true,
    submittedAt: new Date().toISOString(),
    elapsedSec: input.elapsedSec === null ? null : Math.max(0, Math.round(input.elapsedSec)),
  });
  writeData(tp.testJson, Files.test, { ...test, status: 'submitted' });
  rmSync(tp.draftJson, { force: true });
  // 紙の答案が途中まであれば、使わないので片付ける
  rmSync(tp.submission.root, { recursive: true, force: true });
  return reading;
}
