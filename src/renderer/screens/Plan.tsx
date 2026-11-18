import { useEffect, useState } from 'react';
import type { PlanView } from '../../core/plan';
import { daysLeftLabel, formatDateJa } from '../../shared/dates';
import type { Project } from '../../shared/schema';
import { api, errorMessage } from '../api';
import { Empty, ErrorBox, Md, Section } from '../components';
import { JobRow, useJobRunner } from '../jobs';
import { useNav } from '../nav';

const md = (s: string) => s.slice(5).replace('-', '/');

/** 学習計画の画面: 週ごとの計画、通しの模擬試験の予定、遅れたときの作り直し。 */
export function Plan({ projectId }: { projectId: string }) {
  const nav = useNav();
  const [project, setProject] = useState<Project | null>(null);
  const [view, setView] = useState<PlanView | null>(null);
  const [units, setUnits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = async () => {
    try {
      const p = await api.getProject(projectId);
      setProject(p);
      setView(await api.getPlanView(projectId));
      const names: Record<string, string> = {};
      for (const s of p.subjects) {
        const walk = (nodes: Awaited<ReturnType<typeof api.getUnits>>['tree']) => {
          for (const n of nodes) {
            names[`${s.id}/${n.id}`] = n.name;
            walk(n.children);
          }
        };
        walk((await api.getUnits(projectId, s.id)).tree);
      }
      setUnits(names);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const creator = useJobRunner(() => void load());
  const create = (reason: string) => void creator.start(() => api.startCreatePlan(projectId, reason));

  if (!project || !view) return <div className="page" data-testid="screen-plan"><ErrorBox message={error} />{!error && '読み込み中…'}</div>;
  const { plan } = view;
  const subjectName = (id: string) => project.subjects.find((s) => s.id === id)?.name ?? id;
  const weeks = plan ? (showAll ? plan.weeks : plan.weeks.filter((w) => view.currentWeek === null || w.index >= view.currentWeek).slice(0, 6)) : [];

  return (
    <div className="page" data-testid="screen-plan">
      <div className="row">
        <h1>学習計画</h1>
        <span className="muted" data-testid="plan-days-left">
          {daysLeftLabel(view.today, project.examDate)}(試験日 {formatDateJa(project.examDate)})・1日 {project.dailyMinutes} 分
        </span>
      </div>
      <ErrorBox message={error ?? creator.startError} />

      {view.exam !== 'future' ? (
        <div className="notice" data-testid="plan-exam-over">
          {view.exam === 'today' ? '今日が試験日です。新しい計画は作りません。落ち着いて、これまでの復習を見直しましょう。' : '試験日を過ぎています。次の試験に向けて続ける場合は、プロジェクトの設定で試験日を直してください。'}
          {view.exam === 'past' && (
            <div className="buttons">
              <button onClick={() => nav.go({ screen: 'projectEdit', projectId })}>設定を変える</button>
            </div>
          )}
        </div>
      ) : (
        <div className="row">
          <button className={plan ? '' : 'primary'} data-testid="create-plan" disabled={creator.busy} onClick={() => create(plan ? '見直したい' : '')}>
            {plan ? '計画を作り直す' : 'Claude に学習計画を作らせる'}
          </button>
          <span className="hint">試験日・苦手マップ・志望校の傾向・1日に使える時間から、週ごとの計画を作ります。診断テストの採点が済んでいると、より合った計画になります。</span>
        </div>
      )}
      {creator.job && creator.job.status !== 'done' && <JobRow job={creator.job} onRetry={() => create(plan ? '見直したい' : '')} />}

      {plan && view.exam === 'future' && (view.late || view.outdated) && (
        <div className="notice" data-testid="plan-late">
          {view.outdated ? (
            <>{view.outdated}計画を作り直しましょう。</>
          ) : (
            <>
              この {view.progress.doneDays + view.progress.missedDays} 日のうち {view.progress.missedDays} 日、課題ができていません。気にしすぎず、残りの日数に合わせて計画を作り直しましょう。
            </>
          )}
          <div className="buttons">
            <button className="primary" data-testid="plan-replan" disabled={creator.busy} onClick={() => create(view.outdated ?? `直近 ${view.progress.doneDays + view.progress.missedDays} 日のうち ${view.progress.missedDays} 日、課題ができなかった(遅れを取り戻したい)`)}>
              残りの日数に合わせて作り直す
            </button>
          </div>
        </div>
      )}

      {!plan && view.exam === 'future' && <Empty>まだ学習計画がありません。</Empty>}

      {plan && (
        <>
          <Section title="全体の方針" testId="plan-advice">
            <Md text={plan.advice} />
            <div className="muted" data-testid="plan-meta">
              作成 {plan.createdAt.slice(0, 10)}・{plan.weeks.length} 週ぶん{plan.revision > 0 ? `・作り直し ${plan.revision} 回目(${plan.reason})` : ''}
            </div>
          </Section>

          {plan.mocks.length > 0 && (
            <Section title="通しの模擬試験の予定" testId="plan-mocks">
              <div className="hint">本番と同じ形式・時間で通して解きます。予定の日になると、ダッシュボードの「今日の課題」に出ます。</div>
              {plan.mocks.map((m, i) => (
                <div key={i} className="list-item" data-testid="plan-mock">
                  <span className="badge mid">{formatDateJa(m.date)}</span>
                  <span className="grow">{subjectName(m.subjectId)}</span>
                  <span className="muted">{m.testId ? '作成済み' : daysLeftLabel(view.today, m.date).replace('試験まで', '').replace('今日が試験日です', '今日')}</span>
                </div>
              ))}
            </Section>
          )}

          <Section
            title="週ごとの計画"
            testId="plan-weeks"
            actions={
              plan.weeks.length > weeks.length || showAll ? (
                <button className="small" data-testid="plan-show-all" onClick={() => setShowAll(!showAll)}>
                  {showAll ? 'これからの6週だけ表示' : `すべての週を表示(${plan.weeks.length} 週)`}
                </button>
              ) : null
            }
          >
            {weeks.map((w) => (
              <div key={w.index} className={`plan-week ${w.index === view.currentWeek ? 'current' : ''}`} data-testid="plan-week" data-current={w.index === view.currentWeek}>
                <div className="row">
                  <strong>
                    第{w.index + 1}週 {md(w.start)}〜{md(w.end)}
                  </strong>
                  {w.index === view.currentWeek && <span className="badge running">今週</span>}
                  {w.mock && <span className="badge mid">通しの模擬試験</span>}
                  <span data-testid="week-theme">{w.theme}</span>
                </div>
                <table className="grid">
                  <tbody>
                    {w.items.map((it, i) => (
                      <tr key={i} data-testid="week-item">
                        <th style={{ width: 150 }}>{subjectName(it.subjectId)}</th>
                        <td className="num" style={{ width: 80, whiteSpace: 'nowrap' }}>
                          {it.minutes} 分
                        </td>
                        <td>
                          <div>{it.unitIds.map((u) => units[`${it.subjectId}/${u}`] ?? u).join('、')}</div>
                          <div className="muted">{it.goal}</div>
                          {it.chapterUnitIds.map((u) => (
                            <div key={u}>
                              <button className="link" data-testid="week-reading" onClick={() => nav.go({ screen: 'chapter', projectId, subjectId: it.subjectId, unitId: u })}>
                                📖 {view.chapterLabels[`${it.subjectId}/${u}`] ?? u}
                              </button>
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </Section>
        </>
      )}
    </div>
  );
}
