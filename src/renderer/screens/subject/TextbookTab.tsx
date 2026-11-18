import { Fragment, useCallback, useEffect, useState } from 'react';
import type { TextbookView } from '../../../core/textbook';
import type { BuildAllPlan } from '../../../core/textbook_build';
import { CHAPTER_STATUS_LABEL, THICKNESS_LABEL, type ChapterStatus } from '../../../shared/schema';
import { api, errorMessage } from '../../api';
import { Empty, ErrorBox, Md, Meter } from '../../components';
import { JobRow, useJobs } from '../../jobs';
import { useNav } from '../../nav';

const STATUS_TONE: Record<ChapterStatus, string> = { none: '', generating: 'running', done: 'good', stale: 'mid' };

/** 確認問題の結果の一言(「確認問題: 3 問中 2 問」)。 */
export function quizLabel(quiz: { total: number; correct: number | null; status: string } | null): string {
  if (!quiz) return '';
  if (quiz.correct !== null) return `確認問題: ${quiz.total} 問中 ${quiz.correct} 問`;
  return quiz.status === 'ready' ? `確認問題: ${quiz.total} 問(まだ解いていません)` : `確認問題: ${quiz.total} 問(採点待ち)`;
}

/** 科目の「教材」: 単元ツリーの順に並んだ、教科書の代わりのテキスト。目次と章の状態、作る・読む、まとめて作る。 */
export function TextbookTab({ projectId, subjectId }: { projectId: string; subjectId: string }) {
  const nav = useNav();
  const [view, setView] = useState<TextbookView | null>(null);
  const [plan, setPlan] = useState<BuildAllPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdf, setPdf] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [otherNote, setOtherNote] = useState<{ unitId: string; markdown: string } | null>(null);
  const { jobs } = useJobs();
  const mine = jobs.filter((j) => j.kind === 'create_chapter' && j.projectId === projectId && (j.params as { subjectId?: string } | null)?.subjectId === subjectId);
  const unitOf = (j: (typeof mine)[number]) => (j.params as { unitId?: string } | null)?.unitId;
  const liveJob = (unitId: string) => mine.find((j) => unitOf(j) === unitId && (j.status === 'queued' || j.status === 'running')) ?? null;
  // 章ごとに、いちばん新しいジョブが失敗で終わっているものだけ出す
  const failed = mine.filter((j) => j.status === 'failed' && !mine.some((k) => unitOf(k) === unitOf(j) && k.createdAt > j.createdAt));
  // ジョブが増えた・終わったときに、目次を読み直す(採点などで苦手マップが変わったときも)
  const stamp = `${mine.map((j) => `${j.id}:${j.status}`).join(',')}|${jobs.filter((j) => j.projectId === projectId && j.status === 'done').length}`;

  const load = useCallback(() => api.getTextbookView(projectId, subjectId).then(setView, (e) => setError(errorMessage(e))), [projectId, subjectId]);
  useEffect(() => {
    void load();
  }, [load, stamp]);

  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    void fn().then(load, (e) => setError(errorMessage(e)));
  };
  const openChapter = (unitId: string) => nav.go({ screen: 'chapter', projectId, subjectId, unitId });
  const exportAll = async () => {
    setPdfBusy(true);
    setError(null);
    try {
      setPdf((await api.exportTextbookPdf(projectId, subjectId, null)).path);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPdfBusy(false);
    }
  };

  if (!view) return <div data-testid="textbook-tab">{error ? <ErrorBox message={error} /> : '読み込み中…'}</div>;
  const c = view.counts;
  let group: string | null = null;

  return (
    <div data-testid="textbook-tab">
      <div className="hint">
        単元ツリーの順に並んだ教材です。教科書の代わりに、最初から順に読んで学べます。章は「導入 → 要点 → 例題 → よくある誤り → 確認問題」の構成で、苦手な単元ほど詳しく、得意な単元は要点中心になります(1章を作るのに数分、Claude の呼び出しは
        5 回ほど)。
      </div>
      <div className="row">
        <strong data-testid="tb-summary">
          完成 {c.done + c.stale} / {c.total} 章・既読 {c.read} 章
        </strong>
        {c.stale > 0 && <span className="badge mid">作り直しを提案 {c.stale}</span>}
        {c.generating > 0 && <span className="badge running">作成中 {c.generating}</span>}
        <span className="spacer" />
        <button data-testid="tb-build-all" disabled={c.none === 0} onClick={() => act(async () => setPlan(await api.planBuildAll(projectId, subjectId)))}>
          まとめて作る
        </button>
        <button data-testid="tb-export-all" disabled={pdfBusy || c.done + c.stale === 0} onClick={() => void exportAll()}>
          科目全体を PDF に
        </button>
      </div>
      {pdf && (
        <div className="hint" data-testid="tb-export-path">
          保存しました: {pdf}{' '}
          <button className="link" onClick={() => void api.revealFile(pdf)}>
            フォルダで表示
          </button>
        </div>
      )}
      <ErrorBox message={error} />

      {plan && (
        <div className="notice" data-testid="tb-plan">
          {plan.targets.length === 0 ? (
            <div>未作成の章はありません。</div>
          ) : (
            <>
              <div>
                未作成の <strong>{plan.targets.length}</strong> 章を、順に作ります。Claude の呼び出しは <strong data-testid="tb-plan-calls">約 {plan.estimateCalls} 回</strong>(1章 {plan.perChapter} 回が目安。検算の作り直しが多いと最大{' '}
                {plan.maxCalls} 回)。
              </div>
              <div>
                今日の呼び出しは {plan.used} / {plan.limit} 回です。
                {plan.later.length === 0 ? (
                  <> 今日のうちに、すべて並べられます。</>
                ) : (
                  <span data-testid="tb-plan-later">
                    {' '}
                    今日は <strong>{plan.today.length}</strong> 章まで作り、残りの <strong>{plan.later.length}</strong> 章は1日の上限を超えるので、翌日以降に自動で続きを作ります(アプリを開いているとき)。
                  </span>
                )}
              </div>
            </>
          )}
          <div className="buttons">
            {plan.targets.length > 0 && (
              <button
                className="primary"
                data-testid="tb-plan-start"
                onClick={() =>
                  act(async () => {
                    await api.startBuildAll(projectId, subjectId);
                    setPlan(null);
                  })
                }
              >
                この内容で始める
              </button>
            )}
            <button data-testid="tb-plan-cancel" onClick={() => setPlan(null)}>
              やめる
            </button>
          </div>
        </div>
      )}
      {view.deferred.length > 0 && (
        <div className="info" data-testid="tb-deferred">
          あと {view.deferred.length} 章は、1日の上限のため翌日以降に自動で作ります({view.deferredAt} に予約)。{' '}
          <button className="small" data-testid="tb-deferred-cancel" onClick={() => act(() => api.cancelDeferred(projectId, subjectId))}>
            予約を取り消す
          </button>
        </div>
      )}
      {failed.map((j) => (
        <JobRow key={j.id} job={j} onRetry={() => act(() => api.retryJob(j.id))} />
      ))}

      {view.chapters.length === 0 && <Empty>出題の対象の単元がありません。「単元」タブで確かめてください。</Empty>}
      <div className="toc" data-testid="tb-toc">
        {view.chapters.map((ch) => {
          const job = liveJob(ch.unitId);
          const status: ChapterStatus = job ? 'generating' : ch.status === 'generating' ? (ch.chapterVersion > 0 ? 'done' : 'none') : ch.status;
          const built = ch.chapterVersion > 0;
          const head = ch.orphan ? '単元ツリーから外れた章' : ch.group;
          const showGroup = head !== group;
          group = head;
          return (
            <Fragment key={ch.unitId}>
              {showGroup && <div className="toc-group">{head || 'そのほか'}</div>}
              <div className="list-item toc-row" data-testid="tb-row" data-unit-id={ch.unitId} data-status={status} data-read={ch.read} data-unlearned={ch.unlearned}>
                <span className="toc-no">{ch.no > 0 ? `第${ch.no}章` : '(外)'}</span>
                <span className="grow">
                  {built ? (
                    <button className="link toc-title" data-testid="tb-open-title" onClick={() => openChapter(ch.unitId)}>
                      {ch.name}
                    </button>
                  ) : (
                    <strong>{ch.name}</strong>
                  )}{' '}
                  <span className={`badge ${STATUS_TONE[status]}`} data-testid="tb-status">
                    {CHAPTER_STATUS_LABEL[status]}
                  </span>{' '}
                  {ch.read && <span className="badge good">既読</span>} {ch.unlearned && <span className="badge mid">未習</span>} {ch.deferred && !job && <span className="badge">翌日以降に作成</span>}{' '}
                  {ch.hasNote && (
                    <button className="link" data-testid="tb-note" title="前に作った授業ノートを、この章の補足として読めます" onClick={() => openChapter(ch.unitId)}>
                      授業ノートあり
                    </button>
                  )}
                  <div className="muted toc-sub">
                    {ch.mastery !== null ? (
                      <>
                        習熟度 {ch.mastery} <Meter value={ch.mastery} />{' '}
                      </>
                    ) : (
                      '習熟度の記録なし '
                    )}
                    ・{built && ch.thickness ? `厚さ: ${THICKNESS_LABEL[ch.thickness]}(第 ${ch.chapterVersion} 版)` : `作ると: ${THICKNESS_LABEL[ch.plannedThickness]}`}
                    {ch.quiz && (
                      <span data-testid="tb-quiz">
                        {' '}
                        ・{quizLabel(ch.quiz)}
                      </span>
                    )}
                  </div>
                  {status === 'stale' && (
                    <div className="hint" data-testid="tb-stale">
                      {ch.staleReason}
                    </div>
                  )}
                  {job && (
                    <div className="toc-progress" data-testid="tb-progress">
                      <span className="spinner" /> {job.status === 'queued' ? '順番を待っています' : job.progress || '作っています'}
                    </div>
                  )}
                </span>
                <label className="check" title="まだ習っていない単元に付けると、前提から丁寧に書いた章になります">
                  <input type="checkbox" data-testid="tb-unlearned" checked={ch.unlearned} disabled={ch.orphan} onChange={(e) => act(() => api.setChapterUnlearned(projectId, subjectId, ch.unitId, e.target.checked))} />
                  未習
                </label>
                <label className="check">
                  <input type="checkbox" data-testid="tb-read" checked={ch.read} disabled={!built} onChange={(e) => act(() => api.setChapterRead(projectId, subjectId, ch.unitId, e.target.checked))} />
                  既読
                </label>
                {job ? (
                  <button className="small" data-testid="tb-cancel" onClick={() => void api.cancelJob(job.id)}>
                    取り消す
                  </button>
                ) : built ? (
                  <>
                    <button className="small primary" data-testid="tb-open" onClick={() => openChapter(ch.unitId)}>
                      読む
                    </button>
                    {!ch.orphan && (
                      <button className={status === 'stale' ? 'small primary' : 'small'} data-testid="tb-rebuild" onClick={() => act(() => api.startCreateChapter(projectId, subjectId, ch.unitId))}>
                        作り直す
                      </button>
                    )}
                  </>
                ) : (
                  <button className="small" data-testid="tb-create" onClick={() => act(() => api.startCreateChapter(projectId, subjectId, ch.unitId))}>
                    作る
                  </button>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>

      {view.otherNotes.length > 0 && (
        <div className="hint" data-testid="tb-other-notes">
          章の無い単元(単元ツリーから外れた単元)の授業ノートが {view.otherNotes.length} 件あります(消していません)。
          {view.otherNotes.map((n) => (
            <button
              key={n.unitId}
              className="link"
              data-testid="tb-other-note"
              onClick={() => act(async () => setOtherNote(otherNote?.unitId === n.unitId ? null : { unitId: n.unitId, markdown: (await api.getNote(projectId, subjectId, n.unitId))?.markdown ?? '' }))}
            >
              {n.unitId}({n.updatedAt.slice(0, 10)})
            </button>
          ))}
          {otherNote && <Md text={otherNote.markdown} className="note-body" testId="tb-other-note-body" />}
        </div>
      )}
    </div>
  );
}
