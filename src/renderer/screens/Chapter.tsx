import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChapterView } from '../../core/textbook';
import { splitFigures } from '../../shared/chapter';
import { choiceMark } from '../../shared/labels';
import { CHAPTER_STATUS_LABEL, DIFFICULTY_LABEL, PROBLEM_FORMAT_LABEL, THICKNESS_LABEL, type ChapterExample, type ChapterFigure } from '../../shared/schema';
import { api, errorMessage } from '../api';
import { ErrorBox, Md, SvgFigure } from '../components';
import { JobRow, useJobs } from '../jobs';
import { useNav } from '../nav';
import { PdfButtons } from './subject/TestsTab';
import { quizLabel } from './subject/TextbookTab';

/** 章の本文(文章の途中に、図を置く)。 */
function Body({ text, figures, testId }: { text: string; figures: ChapterFigure[]; testId?: string }) {
  const parts = useMemo(() => splitFigures(text, figures), [text, figures]);
  return (
    <div data-testid={testId}>
      {parts.map((p, i) =>
        p.type === 'text' ? (
          <Md key={i} text={p.text} />
        ) : (
          <figure key={i} className="chapter-figure" data-testid="chapter-figure">
            <SvgFigure svg={p.figure.svg} />
            {p.figure.caption && <figcaption className="muted">{p.figure.caption}</figcaption>}
          </figure>
        ),
      )}
    </div>
  );
}

function exampleAnswer(e: ChapterExample): string {
  if (e.format !== 'choice') return e.answer;
  const n = Number(e.answer.normalize('NFKC').match(/\d+/)?.[0] ?? NaN);
  return Number.isFinite(n) && e.choices[n - 1] !== undefined ? `${choiceMark(n - 1)} ${e.choices[n - 1]}` : e.answer;
}

function Choices({ choices }: { choices: string[] }) {
  if (choices.length === 0) return null;
  return (
    <ol className="choices plain">
      {choices.map((c, i) => (
        <li key={i}>
          <span>{choiceMark(i)}</span> <Md text={c} />
        </li>
      ))}
    </ol>
  );
}

/** 章を読む画面。導入 → 要点 → 例題 → よくある誤り →(補足)→ 確認問題。前後の章への移動、既読、PDF 出力。 */
export function Chapter({ projectId, subjectId, unitId }: { projectId: string; subjectId: string; unitId: string }) {
  const nav = useNav();
  const [view, setView] = useState<ChapterView | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdf, setPdf] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const { jobs } = useJobs();
  const mine = jobs.filter((j) => {
    const p = j.params as { subjectId?: string; unitId?: string } | null;
    return (j.kind === 'create_chapter' || j.kind === 'chapter_supplement') && j.projectId === projectId && p?.subjectId === subjectId && p.unitId === unitId;
  });
  const job = mine.at(-1) ?? null;
  const building = mine.find((j) => j.kind === 'create_chapter' && (j.status === 'queued' || j.status === 'running')) ?? null;
  const stamp = `${mine.map((j) => `${j.id}:${j.status}`).join(',')}|${jobs.filter((j) => j.projectId === projectId && j.status === 'done').length}`;

  const load = useCallback(() => api.getChapterView(projectId, subjectId, unitId).then(setView, (e) => setError(errorMessage(e))), [projectId, subjectId, unitId]);
  useEffect(() => {
    void load();
  }, [load, stamp]);
  const hasNote = view?.row.hasNote ?? false;
  useEffect(() => {
    if (!hasNote) return setNote(null);
    api.getNote(projectId, subjectId, unitId).then((n) => setNote(n?.markdown ?? null), () => setNote(null));
  }, [projectId, subjectId, unitId, hasNote]);

  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    void fn().then(load, (e) => setError(errorMessage(e)));
  };
  const goChapter = (id: string) => nav.go({ screen: 'chapter', projectId, subjectId, unitId: id });
  const toToc = () => nav.go({ screen: 'subject', projectId, subjectId, tab: 'textbook' });
  const build = () => act(() => api.startCreateChapter(projectId, subjectId, unitId));
  const exportPdf = async () => {
    setPdfBusy(true);
    setError(null);
    try {
      setPdf((await api.exportTextbookPdf(projectId, subjectId, unitId)).path);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPdfBusy(false);
    }
  };

  if (!view) return <div className="page" data-testid="screen-chapter">{error ? <ErrorBox message={error} /> : '読み込み中…'}</div>;
  const { row, chapter: ch } = view;
  const status = building ? 'generating' : row.status === 'generating' ? (ch ? 'done' : 'none') : row.status;
  const quizAt = ch?.quizTestId ? { projectId, subjectId, testId: ch.quizTestId } : null;

  return (
    <div className="page" data-testid="screen-chapter" data-unit-id={unitId}>
      <div className="row">
        <h1 data-testid="chapter-title">
          {row.no > 0 ? `第${row.no}章 ` : ''}
          {row.name}
        </h1>
        <span className="muted">
          {view.subjectName}
          {row.group ? ` / ${row.group}` : ''}
        </span>
        <span className={`badge ${status === 'done' ? 'good' : status === 'stale' ? 'mid' : status === 'generating' ? 'running' : ''}`} data-testid="chapter-status">
          {CHAPTER_STATUS_LABEL[status]}
        </span>
        {row.read && (
          <span className="badge good" data-testid="chapter-read-badge">
            既読
          </span>
        )}
        {row.unlearned && <span className="badge mid">未習</span>}
        <span className="spacer" />
        <button data-testid="chapter-toc" onClick={toToc}>
          目次へ
        </button>
      </div>
      <div className="row chapter-nav">
        <button data-testid="chapter-prev" disabled={!view.prev} onClick={() => view.prev && goChapter(view.prev.unitId)}>
          ← {view.prev ? `第${view.prev.no}章 ${view.prev.name}` : '前の章はありません'}
        </button>
        <button data-testid="chapter-next" disabled={!view.next} onClick={() => view.next && goChapter(view.next.unitId)}>
          {view.next ? `第${view.next.no}章 ${view.next.name}` : '次の章はありません'} →
        </button>
        <span className="spacer" />
        {ch && (
          <>
            <button className={row.read ? '' : 'primary'} data-testid="chapter-read" onClick={() => act(() => api.setChapterRead(projectId, subjectId, unitId, !row.read))}>
              {row.read ? '既読を外す' : '既読にする'}
            </button>
            <button data-testid="chapter-export" disabled={pdfBusy} onClick={() => void exportPdf()}>
              この章を PDF に
            </button>
            {!row.orphan && (
              <button data-testid="chapter-rebuild" disabled={!!building} onClick={build}>
                作り直す
              </button>
            )}
          </>
        )}
      </div>
      {pdf && (
        <div className="hint" data-testid="chapter-export-path">
          保存しました: {pdf}{' '}
          <button className="link" onClick={() => void api.revealFile(pdf)}>
            フォルダで表示
          </button>
        </div>
      )}
      <ErrorBox message={error} />
      {status === 'stale' && (
        <div className="notice" data-testid="chapter-stale">
          {row.staleReason} 作り直す前の版は残ります。
        </div>
      )}
      {building && (
        <div className="info" data-testid="chapter-building">
          <span className="spinner" /> {building.status === 'queued' ? '順番を待っています' : building.progress || 'Claude が章を作っています'}…(待っている間も他の画面を使えます)
        </div>
      )}
      {job && job.status === 'failed' && <JobRow job={job} onRetry={() => act(() => api.retryJob(job.id))} />}

      {!ch && !building && (
        <div className="empty" data-testid="chapter-empty">
          この章は、まだ作っていません。
          {!row.orphan && (
            <div className="buttons">
              <button className="primary" data-testid="chapter-create" onClick={build}>
                この章を作る({THICKNESS_LABEL[row.plannedThickness]})
              </button>
            </div>
          )}
        </div>
      )}

      {ch && (
        <div className="chapter-layout">
          <article className="chapter-body" data-testid="chapter-body">
            <div className="muted" data-testid="chapter-meta">
              第 {ch.chapterVersion} 版({ch.updatedAt.slice(0, 10)})・厚さ: {THICKNESS_LABEL[ch.thickness]}
              {ch.unlearned ? '・未習の単元として作成' : ''}
              {ch.masteryAtBuild !== null ? `・作成時の習熟度 ${ch.masteryAtBuild}` : ''}
              {view.versions.length > 0 ? `・前の版 ${view.versions.length} つを保存` : ''}
            </div>

            <h2>導入</h2>
            <Body text={ch.intro} figures={ch.figures} testId="chapter-intro" />

            <h2>要点</h2>
            <Body text={ch.points} figures={ch.figures} testId="chapter-points" />

            <h2>例題</h2>
            {ch.examples.map((e, i) => (
              <div key={i} className="chapter-example" data-testid="chapter-example">
                <div className="q-head">
                  <strong>例題{i + 1}</strong>{' '}
                  <span className="muted">
                    ({DIFFICULTY_LABEL[e.difficulty]}・{PROBLEM_FORMAT_LABEL[e.format]})
                  </span>
                </div>
                {e.focus.trim() && <div className="hint">ねらい: {e.focus}</div>}
                <Md text={e.body} />
                <SvgFigure svg={e.figureSvg} />
                <Choices choices={e.choices} />
                <div className="explanation">
                  <h3>解答</h3>
                  <Md text={exampleAnswer(e)} />
                  <h3>解説</h3>
                  <Md text={e.solution || '(解説なし)'} />
                </div>
              </div>
            ))}

            <h2>よくある誤り</h2>
            <Body text={ch.pitfalls} figures={ch.figures} testId="chapter-pitfalls" />

            {ch.supplements.length > 0 && (
              <>
                <h2>補足(質問から)</h2>
                {ch.supplements.map((s, i) => (
                  <div key={i} className="chapter-supplement" data-testid="chapter-supplement">
                    <h3>{s.title}</h3>
                    <Md text={s.markdown} />
                    <div className="muted">{s.at.slice(0, 10)} に追記</div>
                  </div>
                ))}
              </>
            )}

            {note && (
              <details className="section" data-testid="chapter-note">
                <summary>前に作った授業ノート(この章の補足として残してあります)</summary>
                <Md text={note} className="note-body" />
              </details>
            )}

            <h2>確認問題</h2>
            {ch.quiz.length === 0 && <div className="muted">この版には、確認問題がありません。</div>}
            {ch.quiz.map((q, i) => (
              <div key={q.problemId} className="chapter-quiz" data-testid="chapter-quiz-item">
                <div className="q-head">
                  <strong>{i + 1}.</strong>{' '}
                  <span className="muted">
                    ({DIFFICULTY_LABEL[q.difficulty]}・{PROBLEM_FORMAT_LABEL[q.format]}・{q.points} 点)
                  </span>
                </div>
                <Md text={q.body} />
                <SvgFigure svg={q.figureSvg} />
                <Choices choices={q.choices} />
              </div>
            ))}
            {quizAt && row.quiz && (
              <div className="row chapter-quiz-actions" data-testid="chapter-quiz-actions">
                <strong data-testid="chapter-quiz-result">{quizLabel(row.quiz)}</strong>
                {row.quiz.status === 'ready' && (
                  <>
                    <button className="primary" data-testid="quiz-take" onClick={() => nav.go({ screen: 'take', ...quizAt })}>
                      アプリで解く
                    </button>
                    <button data-testid="quiz-paper" onClick={() => nav.go({ screen: 'import', ...quizAt })}>
                      紙の答案を出す
                    </button>
                    <PdfButtons {...quizAt} />
                  </>
                )}
                {row.quiz.status === 'reading' && (
                  <button className="primary" data-testid="quiz-correction" onClick={() => nav.go({ screen: 'correction', projectId, subjectId, sourceId: `sub-${quizAt.testId}` })}>
                    答案の読み取りを確かめる
                  </button>
                )}
                {(row.quiz.status === 'submitted' || row.quiz.status === 'graded') && (
                  <button className="primary" data-testid="quiz-result" onClick={() => nav.go({ screen: 'result', ...quizAt })}>
                    {row.quiz.status === 'graded' ? '結果と解説' : '採点へ'}
                  </button>
                )}
                <span className="hint">解いて提出すると、採点して苦手マップに反映します。</span>
              </div>
            )}

            {view.review && (
              <div className="hint" data-testid="chapter-review">
                点検({view.review.at.slice(0, 10)}): {view.review.issues.length === 0 ? '誤りの指摘なし' : `指摘 ${view.review.issues.length} 件${view.review.revised ? '(直してあります)' : ''}`}
                {view.review.comment ? `。${view.review.comment}` : ''}
              </div>
            )}
            <div className="row chapter-nav">
              <button data-testid="chapter-prev-bottom" disabled={!view.prev} onClick={() => view.prev && goChapter(view.prev.unitId)}>
                ← 前の章
              </button>
              {!row.read && (
                <button className="primary" data-testid="chapter-read-bottom" onClick={() => act(() => api.setChapterRead(projectId, subjectId, unitId, true))}>
                  読み終えた(既読にする)
                </button>
              )}
              <button data-testid="chapter-next-bottom" disabled={!view.next} onClick={() => view.next && goChapter(view.next.unitId)}>
                次の章 →
              </button>
            </div>
          </article>
        </div>
      )}
      {!ch && note && (
        <details className="section" data-testid="chapter-note" open>
          <summary>前に作った授業ノート(この単元)</summary>
          <Md text={note} className="note-body" />
        </details>
      )}
    </div>
  );
}
