import { describe, expect, it } from 'vitest';
import { failureGuide, failureTitle, type FailureKind } from '../../src/shared/failures';
import { done, importFake, makeCore, sampleInput, settled, setupTest, submitAndGrade } from './helpers';

describe('設定画面の「品質」欄', () => {
  it('何も無いうちは、どれも「まだ無い」', () => {
    const t = makeCore();
    t.api.createProject(sampleInput);
    const q = t.api.getQuality();
    expect(q.verify).toEqual({ tests: 0, adopted: 0, regenerated: 0, discarded: 0, total: 0, adoptedRate: null });
    expect(q.problems).toMatchObject({ sources: 0, rate: null });
    expect(q.answers).toMatchObject({ sources: 0, rate: null });
    expect(q.grading).toEqual({ tests: 0, items: 0, overridden: 0, rate: null });
  });

  it('検算の採用・作り直し・破棄の数、読み取りの補正率(問題と答案を分ける)、採点の上書きの数を数える', async () => {
    // 診断テスト(4問): 1問目は作り直しでも合わず破棄 → 代わりを採用。2問目は作り直しで採用
    const { t, p, sid, test, ids } = await setupTest({ kinds: { solve_problems: ['wrong:1,2', 'wrong:1', 'ok'] } });
    expect(t.api.getQuality().verify).toEqual({ tests: 1, adopted: 3, regenerated: 1, discarded: 1, total: 5, adoptedRate: 60 });

    // 問題の読み取り: 1字だけ直す
    const exam = importFake(t, p.id, sid, 1, 'past_exam', '過去問');
    await done(t, t.api.startReadSource(p.id, sid, exam));
    const v = t.api.getCorrectionView(p.id, sid, exam);
    const q0 = v.extracted!.problems[0];
    t.api.updateProblem(p.id, sid, exam, q0.id, { body: q0.body.replace('2次方程式', '二次方程式') });
    t.api.confirmSource(p.id, sid, exam);
    const q1 = t.api.getQuality();
    expect(q1.problems).toMatchObject({ sources: 1, changedChars: 1, edits: 1 });
    expect(q1.problems.originalChars).toBe(v.stats.originalChars);
    expect(q1.problems.rate).toBe(Math.round((1 / v.stats.originalChars) * 1000) / 10);
    expect(q1.answers.sources).toBe(0);

    // 答案の読み取り: 紙の答案を取り込み、1つ直して確定 → 採点 → 上書き
    const sub = importFake(t, p.id, sid, 1, 'answer', '紙の答案', test.id);
    await done(t, t.api.startReadSource(p.id, sid, sub));
    const sv = t.api.getCorrectionView(p.id, sid, sub);
    t.api.updateProblem(p.id, sid, sub, sv.extracted!.problems[0].id, { body: '2' });
    t.api.confirmSource(p.id, sid, sub);
    await submitGrade(t, ids);
    t.api.overrideGrade(...ids, 'p02', 5, '途中まで合っている');
    const q2 = t.api.getQuality();
    expect(q2.answers.sources).toBe(1);
    expect(q2.answers.changedChars).toBeGreaterThan(0);
    expect(q2.answers.rate).toBeGreaterThan(0);
    expect(q2.problems.sources).toBe(1); // 答案は、問題の読み取りに混ぜない
    expect(q2.grading).toEqual({ tests: 1, items: test.problems.length, overridden: 1, rate: Math.round((1 / test.problems.length) * 1000) / 10 });
  });
});

async function submitGrade(t: Awaited<ReturnType<typeof setupTest>>['t'], ids: readonly [string, string, string]) {
  const job = await done(t, t.api.startGrade(...ids));
  const explainJobId = (job.result as { explainJobId?: string | null }).explainJobId;
  if (explainJobId) await settled(t, t.core.jobs.get(explainJobId)!);
}

describe('失敗時の案内', () => {
  it('claude が無い・未ログイン・使用量上限・通信失敗・1日の上限を見分けて、日本語の案内を出す', async () => {
    const cases: Array<[control: Record<string, unknown>, kind: FailureKind, title: string, guide: string]> = [
      [{ notFound: true }, 'not_found', '見つかりません', 'claude の場所'],
      [{ default: 'not_logged_in' }, 'not_logged_in', 'ログインしていません', '/login'],
      [{ default: 'usage_limit' }, 'usage_limit', '使用量の上限', '待ってから'],
      [{ default: 'network' }, 'network', '通信に失敗', 'インターネットの接続'],
    ];
    const t = makeCore();
    for (const [control, kind, title, guide] of cases) {
      t.fake.set(control);
      const job = await settled(t, t.api.startPing());
      expect(job.status, kind).toBe('failed');
      expect(job.error?.kind).toBe(kind);
      expect(failureTitle(kind)).toContain(title);
      expect(failureGuide(kind)).toContain(guide);
      // 直ったら、同じジョブを「もう一度試す」で通せる
      t.fake.set({});
      expect((await settled(t, t.api.retryJob(job.id))).status).toBe('done');
    }
    // 1日の上限
    t.api.updateSettings({ dailyLimit: t.api.usage().used });
    const over = await settled(t, t.api.startPing());
    expect(over.error?.kind).toBe('daily_limit');
    expect(failureGuide('daily_limit')).toContain('1日の上限');
    t.api.updateSettings({ dailyLimit: 200 });
    expect((await settled(t, t.api.retryJob(over.id))).status).toBe('done');
  });
});
