import { useEffect, useState } from 'react';
import type { TodayView } from '../../core/daily';
import { PROBLEM_ORIGIN_LABEL, type ProblemOrigin, type Test } from '../../shared/schema';
import { api, errorMessage } from '../api';
import { ErrorBox, Section } from '../components';
import { useJobs } from '../jobs';
import { useNav } from '../nav';
import { TestRow } from './subject/TestsTab';

/** 課題の中身の内訳(苦手克服 3・過去問の類題 2・復習 1)。 */
export function mixLabel(test: Test): string {
  const count = new Map<ProblemOrigin, number>();
  for (const p of test.problems) count.set(p.origin, (count.get(p.origin) ?? 0) + 1);
  return [...count.entries()].map(([o, n]) => `${PROBLEM_ORIGIN_LABEL[o]} ${n}`).join('・');
}

/** ダッシュボードの「今日の課題」: 今日あつかう科目の課題と、予定の日が来た通しの模擬試験。 */
export function TodaySection({ projectId }: { projectId: string }) {
  const nav = useNav();
  const [view, setView] = useState<TodayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { jobs } = useJobs();
  const mine = jobs.filter((j) => j.projectId === projectId);
  const finished = mine.filter((j) => j.status !== 'running' && j.status !== 'queued').length;
  const busy = (kind: string, subjectId: string) => mine.some((j) => j.kind === kind && (j.status === 'running' || j.status === 'queued') && (j.params as { subjectId?: string } | null)?.subjectId === subjectId);
  useEffect(() => {
    api.getTodayView(projectId).then(setView, (e) => setError(errorMessage(e)));
  }, [projectId, finished]);

  if (!view) return error ? <ErrorBox message={error} /> : null;
  const [, m, d] = view.date.split('-').map(Number);
  const missing = view.subjects.filter((s) => !s.test && !busy('create_daily', s.subjectId));
  const run = (p: Promise<unknown>) => void p.catch((e) => setError(errorMessage(e)));

  return (
    <Section
      title={`今日の課題(${m}月${d}日)`}
      testId="today"
      actions={
        missing.length > 0 ? (
          <button className="primary" data-testid="today-create" onClick={() => run(api.startCreateToday(projectId))}>
            今日の課題を作る
          </button>
        ) : null
      }
    >
      <ErrorBox message={error} />
      {!view.hasPlan && (
        <div className="hint" data-testid="today-no-plan">
          学習計画を作ると、計画に沿った課題になります。{' '}
          <button className="link" onClick={() => nav.go({ screen: 'plan', projectId })}>
            学習計画へ
          </button>
        </div>
      )}
      {view.mocks.map((mk) => (
        <div key={`mock-${mk.subjectId}-${mk.date}`} data-testid="today-mock" data-subject={mk.name}>
          {mk.test ? (
            <TestRow projectId={projectId} test={mk.test} />
          ) : (
            <div className="list-item">
              <span className="badge mid">通しの模擬試験</span>
              <span className="grow">
                <strong>{mk.name}</strong> <span className="muted">予定日 {mk.date}。本番と同じ形式・時間で、通して解きます。</span>
              </span>
              {busy('create_mock', mk.subjectId) ? (
                <span>
                  <span className="spinner" /> 作っています
                </span>
              ) : (
                <button className="small primary" data-testid="mock-create" onClick={() => run(api.startCreateMock(projectId, mk.subjectId))}>
                  模擬試験を作る
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      {view.subjects.map((s) => (
        <div key={s.subjectId} data-testid="today-item" data-subject={s.name}>
          {s.test ? (
            <>
              <TestRow projectId={projectId} test={s.test} />
              <div className="hint today-mix" data-testid="today-mix">
                内訳: {mixLabel(s.test)}
              </div>
            </>
          ) : (
            <div className="list-item">
              <span className="badge">今日の課題</span>
              <span className="grow">
                <strong>{s.name}</strong>{' '}
                <span className="muted">
                  目安 {s.minutes} 分{s.dueReviews > 0 ? `・復習の期限が来た問題 ${s.dueReviews}` : ''}
                </span>
              </span>
              {busy('create_daily', s.subjectId) ? (
                <span data-testid="today-creating">
                  <span className="spinner" /> Claude が作っています
                </span>
              ) : (
                <button className="small" data-testid="today-create-one" onClick={() => run(api.startCreateDaily(projectId, s.subjectId))}>
                  この科目だけ作る
                </button>
              )}
            </div>
          )}
          {s.reading && (
            <div className="list-item" data-testid="today-reading" data-unit-id={s.reading.unitId}>
              <span className="badge">教材</span>
              <span className="grow">
                <strong data-testid="today-reading-label">{s.reading.label}</strong> <span className="muted">({s.name}・{s.reading.reason})</span>
              </span>
              <button className="small" data-testid="today-reading-open" onClick={() => nav.go({ screen: 'chapter', projectId, subjectId: s.subjectId, unitId: s.reading!.unitId })}>
                {s.reading.status === 'done' || s.reading.status === 'stale' ? '読む' : '章を開く(未作成)'}
              </button>
            </div>
          )}
        </div>
      ))}
    </Section>
  );
}
