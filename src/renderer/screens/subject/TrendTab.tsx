import { useEffect, useState } from 'react';
import type { TrendView } from '../../../core/trend';
import { api, errorMessage } from '../../api';
import { Empty, ErrorBox, Md } from '../../components';
import { JobRow, useJobRunner, useJobs } from '../../jobs';
import { useNav } from '../../nav';

/** 科目の「傾向」: 確定した過去問からまとめた、志望校の出題傾向。 */
export function TrendTab({ projectId, subjectId }: { projectId: string; subjectId: string }) {
  const nav = useNav();
  const [view, setView] = useState<TrendView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { jobs } = useJobs();
  const load = () => api.getTrendView(projectId, subjectId).then(setView, (e) => setError(errorMessage(e)));
  const mine = jobs.filter((j) => j.projectId === projectId && (j.params as { subjectId?: string } | null)?.subjectId === subjectId);
  const finished = mine.filter((j) => j.status === 'done').length;
  // 補正画面で過去問を確定したときに始まった分析も、ここに出す
  const running = mine.find((j) => j.kind === 'update_trend' && (j.status === 'running' || j.status === 'queued'));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, subjectId, finished]);

  const updater = useJobRunner(() => void load());
  const rediag = useJobRunner(() => void load());
  const update = () => void updater.start(() => api.startUpdateTrend(projectId, subjectId));

  if (!view) return <ErrorBox message={error} />;
  const t = view.trend;
  return (
    <div data-testid="trend-tab">
      <div className="row">
        <button className={t && !view.stale ? '' : 'primary'} data-testid="update-trend" disabled={updater.busy || !!running || view.pastExams.length === 0} onClick={update}>
          {t ? '傾向を更新する' : '傾向をまとめる'}
        </button>
        <span className="hint" data-testid="trend-sources">
          確定した過去問 {view.pastExams.length} 件{view.pastExams.length > 0 ? `(${view.pastExams.map((s) => s.title).join('、')})` : ''}
        </span>
      </div>
      {updater.job && updater.job.status !== 'done' ? <JobRow job={updater.job} onRetry={update} /> : running ? <JobRow job={running} /> : null}
      <ErrorBox message={error ?? updater.startError ?? rediag.startError} />
      {view.stale && t && (
        <div className="notice" data-testid="trend-stale">
          確定した過去問が、前回まとめたときから変わっています。「傾向を更新する」で反映できます。
        </div>
      )}
      {view.suggestRediagnosis && (
        <div className="notice" data-testid="rediag-suggest">
          志望校の傾向が分かりました。傾向を踏まえた実力診断テストを作り直すと、いまの位置がより正確に分かります。
          <div className="buttons">
            <button className="primary" data-testid="rediag-create" disabled={rediag.busy} onClick={() => void rediag.start(() => api.startCreateDiagnostic(projectId, subjectId))}>
              傾向を踏まえて再診断する
            </button>
          </div>
          {rediag.job && rediag.job.status !== 'done' && <JobRow job={rediag.job} />}
        </div>
      )}
      {!t && (
        <Empty>
          {view.pastExams.length === 0 ? (
            <>
              志望校の傾向は、過去問を取り込んで「確定」すると、Claude がまとめます。
              <div className="buttons">
                <button data-testid="trend-import" onClick={() => nav.go({ screen: 'import', projectId, subjectId })}>
                  過去問の PDF を取り込む
                </button>
              </div>
            </>
          ) : (
            '「傾向をまとめる」を押すと、確定した過去問から Claude が出題傾向をまとめます。'
          )}
        </Empty>
      )}
      {t && (
        <div data-testid="trend-body">
          <div className="muted">更新: {t.updatedAt.slice(0, 10)}(過去問 {t.basedOn.length} 件から)</div>
          <div className="section">
            <Md text={t.summaryMd} testId="trend-summary" />
          </div>
          <table className="grid">
            <tbody>
              <tr>
                <th>出題形式</th>
                <td data-testid="trend-format">{t.format}</td>
              </tr>
              <tr>
                <th>大問構成</th>
                <td data-testid="trend-structure">
                  {t.structure.map((s, i) => (
                    <div key={i}>
                      <strong>{s.label}</strong> {s.description}
                    </div>
                  ))}
                </td>
              </tr>
              <tr>
                <th>頻出単元</th>
                <td data-testid="trend-units">
                  {t.frequentUnits.map((u, i) => (
                    <div key={i}>
                      <strong>{u.unit}</strong> {u.note}
                    </div>
                  ))}
                </td>
              </tr>
              <tr>
                <th>分量</th>
                <td>{t.volume}</td>
              </tr>
              <tr>
                <th>時間配分</th>
                <td>{t.timeAllocation}</td>
              </tr>
              <tr>
                <th>難易度</th>
                <td>{t.difficulty}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
