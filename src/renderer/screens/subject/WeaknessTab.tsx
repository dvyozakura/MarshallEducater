import { useEffect, useState } from 'react';
import type { WeaknessView } from '../../../core/weakness';
import { MISTAKE_LABEL, MISTAKE_TYPES } from '../../../shared/schema';
import { api, errorMessage } from '../../api';
import { Empty, ErrorBox, Meter } from '../../components';
import { useJobs } from '../../jobs';

/** 習熟度の推移(小さな折れ線)。 */
export function Sparkline({ points }: { points: Array<{ date: string; mastery: number }> }) {
  if (points.length < 2) return <span className="muted">{points.length === 1 ? '1回' : ''}</span>;
  const w = 90;
  const h = 24;
  const xs = points.map((_p, i) => (i / (points.length - 1)) * (w - 4) + 2);
  const ys = points.map((p) => h - 2 - (Math.max(0, Math.min(100, p.mastery)) / 100) * (h - 4));
  return (
    <svg width={w} height={h} className="spark" data-testid="sparkline" role="img" aria-label={`習熟度の推移: ${points.map((p) => `${p.date} ${p.mastery}`).join('、')}`}>
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')} />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r="2.2" fill="currentColor" />
    </svg>
  );
}

/** 科目の苦手マップ: 単元 × ミスの種類の表と、習熟度の一覧・推移。 */
export function WeaknessTab({ projectId, subjectId }: { projectId: string; subjectId: string }) {
  const [view, setView] = useState<WeaknessView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { jobs } = useJobs();
  const finished = jobs.filter((j) => j.projectId === projectId && j.status === 'done').length;
  useEffect(() => {
    api.getWeaknessView(projectId, subjectId).then(setView, (e) => setError(errorMessage(e)));
  }, [projectId, subjectId, finished]);

  if (!view) return <ErrorBox message={error} />;
  if (view.rows.length === 0) return <Empty>苦手マップは、テストや課題を採点すると、ここに出ます。まずは実力診断テストを解いてみましょう。</Empty>;
  return (
    <div data-testid="weakness-tab">
      <div className="row">
        <strong data-testid="weakness-overall">科目全体の習熟度 {view.overall}</strong>
        <Meter value={view.overall ?? 0} />
        <span className="muted">
          記録のある単元 {view.rows.length}・まだ出題していない単元 {view.untested}
        </span>
      </div>
      <div className="hint">習熟度は 0〜100。正誤・問題の難しさ・新しさから計算します(古い結果ほど軽く扱います)。弱い単元から順に並べています。数字は、その種類のミスをした回数です。</div>
      <table className="grid" data-testid="weakness-table">
        <thead>
          <tr>
            <th>単元</th>
            <th>習熟度</th>
            <th className="num">回数</th>
            {MISTAKE_TYPES.map((m) => (
              <th key={m} className="num">
                {MISTAKE_LABEL[m]}
              </th>
            ))}
            <th>推移</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((r) => (
            <tr key={r.unitId} data-testid="weakness-row" data-unit-id={r.unitId}>
              <td>{r.unitName}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <Meter value={r.mastery} /> <span data-testid="weakness-mastery">{r.mastery}</span>
              </td>
              <td className="num">{r.attempts}</td>
              {MISTAKE_TYPES.map((m) => (
                <td key={m} className={`num ${r.mistakes[m] ? 'miss' : 'muted'}`} data-testid={`miss-${m}`}>
                  {r.mistakes[m] || '·'}
                </td>
              ))}
              <td>
                <Sparkline points={r.history} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
