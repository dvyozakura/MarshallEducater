import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { requireConfirmedReading } from '../../src/core/answers';
import { Files, readData, writeData } from '../../src/core/store';
import { done, importFake, makeCore, putTest, sampleInput } from './helpers';

function setup() {
  const t = makeCore();
  const p = t.api.createProject(sampleInput);
  const sid = p.subjects[0].id;
  putTest(t, p.id, sid);
  const tp = t.core.paths(p.id).subject(sid).test('test-1');
  const status = () => readData(tp.testJson, Files.test).status;
  return { t, p, sid, tp, status, ids: [p.id, sid, 'test-1'] as const };
}

describe('アプリ内で解く(途中の控えと提出)', () => {
  it('途中の控えを保存し、開き直すと続きから。提出すると確定した答案になる', () => {
    const { t, tp, status, ids, p, sid } = setup();
    expect(t.api.getTakeView(...ids)).toMatchObject({ draft: null, reading: null });
    expect(JSON.stringify(t.api.getTakeView(...ids))).not.toContain('answer_key');

    const d1 = t.api.saveDraft(...ids, { answers: { p1: ' 3 ', p2: '', zzz: 'x' }, elapsedSec: 61.4 });
    expect(d1.answers).toEqual({ p1: ' 3 ' }); // 空の答えと、テストに無い設問は捨てる
    expect(d1.elapsedSec).toBe(61);
    const d2 = t.api.saveDraft(...ids, { answers: { p1: '3', p2: '$x=2$' }, elapsedSec: 120, extended: true });
    expect(d2.startedAt).toBe(d1.startedAt);
    expect(t.api.getTakeView(...ids).draft).toMatchObject({ answers: { p1: '3', p2: '$x=2$' }, elapsedSec: 120, extended: true });
    expect(status()).toBe('ready');
    expect(() => requireConfirmedReading(t.core, p.id, sid, 'test-1')).toThrow('まだ出されていません');

    expect(() => t.api.submitAnswers(...ids, { answers: { p9: 'x' }, elapsedSec: 1 })).toThrow('このテストに無い設問');
    const r = t.api.submitAnswers(...ids, { answers: { p2: ' $x=2$ ' }, elapsedSec: 130.2 });
    expect(r).toMatchObject({ method: 'inapp', confirmed: true, elapsedSec: 130 });
    expect(r.answers).toEqual([
      { problemId: 'p1', answer: '' },
      { problemId: 'p2', answer: '$x=2$' },
    ]);
    expect(status()).toBe('submitted');
    expect(existsSync(tp.draftJson)).toBe(false);
    expect(requireConfirmedReading(t.core, p.id, sid, 'test-1').answers).toHaveLength(2);
    expect(() => t.api.saveDraft(...ids, { answers: {}, elapsedSec: 0 })).toThrow('もう提出されています');
  });

  it('採点済みのテストには、出し直せない', () => {
    const { t, tp, ids, p, sid } = setup();
    writeData(tp.testJson, Files.test, { ...readData(tp.testJson, Files.test), status: 'graded' });
    expect(() => t.api.submitAnswers(...ids, { answers: {}, elapsedSec: 0 })).toThrow('採点済み');
    expect(() => t.api.importBegin(p.id, sid, { kind: 'answer', title: '答案', fileName: 'a.png', testId: 'test-1' })).toThrow('採点済み');
  });
});

describe('紙の答案を出す', () => {
  it('取り込むと「読み取り・補正中」になり、確定で「提出済み」。取り消すと「未提出」に戻る', async () => {
    const { t, tp, status, p, sid } = setup();
    t.api.saveDraft(p.id, sid, 'test-1', { answers: { p1: '1' }, elapsedSec: 5 });
    const sourceId = importFake(t, p.id, sid, 2, 'answer', '紙の答案', 'test-1');
    expect(status()).toBe('reading');
    expect(existsSync(tp.draftJson)).toBe(false);
    expect(existsSync(tp.submission.sourceJson)).toBe(true);
    // 答案は、科目の資料の一覧には出ない
    expect(t.api.listSources(p.id, sid)).toHaveLength(0);

    await done(t, t.api.startReadSource(p.id, sid, sourceId));
    expect(t.fake.calls()[0].prompt).toContain('答案(受験生が書いた解答)の書き起こし');
    expect(status()).toBe('reading');
    t.api.confirmSource(p.id, sid, sourceId);
    expect(status()).toBe('submitted');
    expect(requireConfirmedReading(t.core, p.id, sid, 'test-1').method).toBe('scan');

    // 出し直し: 前の答案は消え、また読み取りから
    const again = importFake(t, p.id, sid, 1, 'answer', '紙の答案(出し直し)', 'test-1');
    expect(again).toBe(sourceId);
    expect(status()).toBe('reading');
    expect(existsSync(tp.readingJson)).toBe(false);
    expect(t.api.getCorrectionView(p.id, sid, sourceId).extracted).toBeNull();

    t.api.deleteSource(p.id, sid, sourceId);
    expect(status()).toBe('ready');
  });

  it('紙の答案の途中でも、アプリ内の入力で出し直せる(紙の答案は片付ける)', () => {
    const { t, tp, status, ids, p, sid } = setup();
    importFake(t, p.id, sid, 1, 'answer', '紙の答案', 'test-1');
    expect(status()).toBe('reading');
    t.api.submitAnswers(...ids, { answers: { p1: '2' }, elapsedSec: null });
    expect(status()).toBe('submitted');
    expect(existsSync(tp.submission.root)).toBe(false);
    expect(requireConfirmedReading(t.core, p.id, sid, 'test-1')).toMatchObject({ method: 'inapp', elapsedSec: null });
  });
});
