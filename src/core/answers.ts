// 答案(reading.json)の読み書き。採点に使えるのは「確定した答案」だけ。
import { existsSync } from 'node:fs';
import type { Reading } from '../shared/schema';
import type { AppCore } from './app';
import { Files, readData } from './store';

export function getReading(core: AppCore, projectId: string, subjectId: string, testId: string): Reading | null {
  const tp = core.paths(projectId).subject(subjectId).test(testId);
  return existsSync(tp.readingJson) ? readData(tp.readingJson, Files.reading) : null;
}

/** 採点など後の処理の入口。確定した答案が無ければ、理由を添えて断る。 */
export function requireConfirmedReading(core: AppCore, projectId: string, subjectId: string, testId: string): Reading {
  const reading = getReading(core, projectId, subjectId, testId);
  if (!reading) throw new Error('このテストの答案がまだ出されていません。');
  if (!reading.confirmed) throw new Error('答案の読み取り結果がまだ確定されていません。補正画面で確かめて「確定」してください。');
  return reading;
}
