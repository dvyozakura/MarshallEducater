import { useCallback, useEffect, useState } from 'react';
import type { ResultView } from '../../core/grading';
import { formatElapsed } from '../../shared/dates';
import { choiceMark } from '../../shared/labels';
import { DIFFICULTY_LABEL, MISTAKE_LABEL, PROBLEM_FORMAT_LABEL, TEST_STATUS_LABEL, type GradeItem, type Problem } from '../../shared/schema';
import { api, errorMessage } from '../api';
import { ErrorBox, Md, Section, SvgFigure, MadeByTag } from '../components';
import { JobRow, useJobs } from '../jobs';
import { useNav } from '../nav';

/** 選択式の答え(番号)を、記号と選択肢の文で見せる。 */
function answerText(p: Problem, answer: string): string {
  if (!answer.trim()) return '(未解答)';
  if (p.format !== 'choice') return answer;
  const n = Number(answer.normalize('NFKC').match(/\d+/)?.[0] ?? NaN);
  return Number.isFinite(n) && p.choices[n - 1] !== undefined ? `${choiceMark(n - 1)} ${p.choices[n - 1]}` : answer;
}

function OverrideForm({ item, onSave }: { item: GradeItem; onSave: (score: number | null, note: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [score, setScore] = useState(String(item.override?.score ?? item.score));
  const [note, setNote] = useState(item.override?.note ?? '');
  if (!open) {
    return (
      <div className="row">
        {item.override && (
          <span className="badge mid" data-testid="override-badge">
            上書き済み(Claude の採点は {item.score} 点){item.override.note ? `: ${item.override.note}` : ''}
          </span>
        )}
        <button className="small" data-testid="override-open" onClick={() => setOpen(true)}>
          採点を直す
        </button>
        {item.override && (
          <button className="small" data-testid="override-clear" onClick={() => void onSave(null, '')}>
            上書きを取り消す
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="row" data-testid="override-form">
      <label>
        点数 <input data-testid="override-score" type="number" min={0} max={item.max} step="any" value={score} onChange={(e) => setScore(e.target.value)} style={{ width: 70 }} /> / {item.max}
      </label>
      <input data-testid="override-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="理由(例: 途中式は合っているので部分点)" style={{ flex: 1, minWidth: 200 }} />
      <button className="primary small" data-testid="override-save" disabled={score.trim() === ''} onClick={() => void onSave(Number(score), note).then(() => setOpen(false))}>
        この点数にする
      </button>
      <button className="small" onClick={() => setOpen(false)}>
        やめる
      </button>
    </div>
  );
}

/** 採点結果と解説の画面。 */
export function Result({ projectId, subjectId, testId }: { projectId: string; subjectId: string; testId: string }) {
  const nav = useNav();
  const [view, setView] = useState<ResultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { jobs } = useJobs();
  const mine = jobs.filter((j) => (j.params as { testId?: string } | null)?.testId === testId);
  const gradeJob = mine.filter((j) => j.kind === 'grade').at(-1) ?? null;
  const explainJob = mine.filter((j) => j.kind === 'explain').at(-1) ?? null;
  const [pdf, setPdf] = useState<string | null>(null);
  const finished = mine.filter((j) => j.status === 'done').length;

  const load = useCallback(() => api.getResultView(projectId, subjectId, testId).then(setView, (e) => setError(errorMessage(e))), [projectId, subjectId, testId]);
  useEffect(() => {
    void load();
  }, [load, finished]);

  if (!view) return <div className="page"><ErrorBox message={error} />{!error && '読み込み中…'}</div>;
  const { test, reading, grading, key, totals, explanations } = view;
  const explained = new Map((explanations?.items ?? []).map((e) => [e.problemId, e]));
  const unexplained = (grading?.items ?? []).filter((i) => (i.override ? i.override.score : i.score) < i.max && !explained.has(i.problemId)).length;
  const explainBusy = !!explainJob && (explainJob.status === 'queued' || explainJob.status === 'running');
  const explain = () => api.startExplain(projectId, subjectId, testId).catch((e) => setError(errorMessage(e)));
  const exportPdf = () =>
    api.exportTestPdf(projectId, subjectId, testId, 'explanations').then(
      (r) => setPdf(r.path),
      (e) => setError(errorMessage(e)),
    );
  const grade = () => api.startGrade(projectId, subjectId, testId).catch((e) => setError(errorMessage(e)));
  const grading_busy = !!gradeJob && (gradeJob.status === 'queued' || gradeJob.status === 'running');
  const answerOf = (id: string) => reading?.answers.find((a) => a.problemId === id)?.answer ?? '';
  const override = async (problemId: string, score: number | null, note: string) => {
    setError(null);
    try {
      await api.overrideGrade(projectId, subjectId, testId, problemId, score, note);
      await load();
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    }
  };

  return (
    <div className="page" data-testid="screen-result">
      <div className="row">
        <h1>{test.title}</h1>
        <span className={`badge ${test.status === 'graded' ? 'good' : 'mid'}`} data-testid="result-status">
          {TEST_STATUS_LABEL[test.status]}
        </span>
        <span className="spacer" />
        <button data-testid="result-back" onClick={() => nav.go({ screen: 'subject', projectId, subjectId, tab: 'tests' })}>
          科目の画面へ
        </button>
      </div>
      <ErrorBox message={error} />

      {!grading && (
        <Section title="採点" testId="result-pending">
          {test.status === 'ready' && <div>まだ答案が出されていません。</div>}
          {test.status === 'reading' && (
            <div>
              紙の答案の読み取り結果が、まだ確定されていません。
              <div className="buttons">
                <button className="primary" onClick={() => nav.go({ screen: 'correction', projectId, subjectId, sourceId: `sub-${testId}` })}>
                  答案の読み取りを確かめる
                </button>
              </div>
            </div>
          )}
          {test.status === 'submitted' && (
            <>
              <div data-testid="result-submitted">答案を受け取りました。Claude が解答・採点基準に照らして採点します(数分かかることがあります。待っている間も他の画面を使えます)。</div>
              {gradeJob && gradeJob.status !== 'done' && <JobRow job={gradeJob} onRetry={() => void grade()} />}
              {!grading_busy && (
                <div className="buttons">
                  <button className="primary" data-testid="grade-start" onClick={() => void grade()}>
                    Claude に採点させる
                  </button>
                </div>
              )}
            </>
          )}
        </Section>
      )}

      {grading && totals && (
        <>
          <div className="hero">
            <div>
              <div className="countdown" data-testid="result-total">
                {totals.score} / {totals.max} 点({totals.max > 0 ? Math.round((totals.score / totals.max) * 100) : 0}%)
              </div>
              <div className="muted">
                {reading?.method === 'scan' ? '紙の答案' : 'アプリ内で解答'}
                {reading?.elapsedSec != null ? ` ・ かかった時間 ${formatElapsed(reading.elapsedSec * 1000)}(制限 ${test.timeLimitMin} 分)` : ''}{' '}
                <MadeByTag madeBy={grading.madeBy} what="採点" testId="madeby-grading" /> <MadeByTag madeBy={explanations?.madeBy} what="解説" testId="madeby-explain" /> <MadeByTag madeBy={test.madeBy} what="問題" testId="madeby-test" />
              </div>
            </div>
            <div className="result-marks" data-testid="result-marks">
              {grading.items.map((it) => {
                const s = it.override ? it.override.score : it.score;
                return (
                  <span key={it.problemId} className={`mark ${s >= it.max ? 'good' : s > 0 ? 'mid' : 'low'}`} title={`${s} / ${it.max}`}>
                    {s >= it.max ? '○' : s > 0 ? '△' : '×'}
                  </span>
                );
              })}
            </div>
          </div>

          {(unexplained > 0 || explained.size > 0) && (
            <Section title="解説" testId="explain-section">
              {unexplained > 0 && !explainBusy && explainJob?.status !== 'failed' && (
                <div className="row">
                  <span data-testid="explain-missing">間違えた問題のうち {unexplained} 問に、まだ解説がありません。</span>
                  <button className="primary small" data-testid="explain-start" onClick={() => void explain()}>
                    Claude に解説を書かせる
                  </button>
                </div>
              )}
              {unexplained > 0 && explainJob && explainJob.status !== 'done' && <JobRow job={explainJob} onRetry={() => void explain()} />}
              {unexplained === 0 && (
                <div className="row">
                  <span data-testid="explain-ready">間違えた {explained.size} 問の解説があります(各設問の下)。</span>
                  <button className="small" data-testid="export-explanations" onClick={() => void exportPdf()}>
                    解説を PDF に
                  </button>
                  {pdf && (
                    <span className="hint" data-testid="export-path">
                      保存しました: {pdf}{' '}
                      <button className="link" onClick={() => void api.revealFile(pdf)}>
                        フォルダで表示
                      </button>
                    </span>
                  )}
                </div>
              )}
            </Section>
          )}

          {test.problems.map((p) => {
            const it = grading.items.find((i) => i.problemId === p.id);
            const ex = explained.get(p.id);
            if (!it) return null;
            const s = it.override ? it.override.score : it.score;
            const k = key?.items.find((x) => x.problemId === p.id);
            const tone = s >= it.max ? 'good' : s > 0 ? 'mid' : 'low';
            return (
              <section key={p.id} className={`section result-item ${tone}`} data-testid="result-item" data-problem-id={p.id} data-tone={tone}>
                <div className="row">
                  <h2>
                    {s >= it.max ? '○' : s > 0 ? '△' : '×'} {p.number}
                  </h2>
                  <span className={`badge ${tone}`} data-testid="item-score">
                    {s} / {it.max} 点
                  </span>
                  <span className="muted">
                    {p.unitName}・{PROBLEM_FORMAT_LABEL[p.format]}・{DIFFICULTY_LABEL[p.difficulty]}
                  </span>
                  {it.mistake && s < it.max && (
                    <span className="badge low" data-testid="item-mistake">
                      {MISTAKE_LABEL[it.mistake]}
                    </span>
                  )}
                </div>
                <Md text={p.body} />
                <SvgFigure svg={p.figureSvg} />
                {p.choices.length > 0 && (
                  <ol className="choices plain">
                    {p.choices.map((c, i) => (
                      <li key={i}>
                        <span>{choiceMark(i)}</span> <Md text={c} />
                      </li>
                    ))}
                  </ol>
                )}
                <div className="split result-answers">
                  <div>
                    <div className="hint">あなたの答案</div>
                    <div className="preview" data-testid="item-answer">
                      <Md text={answerText(p, answerOf(p.id))} />
                    </div>
                  </div>
                  <div>
                    <div className="hint">正解</div>
                    <div className="preview" data-testid="item-key">
                      <Md text={answerText(p, k?.answer ?? '')} />
                    </div>
                  </div>
                </div>
                <div className="result-note">
                  <strong>採点の根拠</strong> <span data-testid="item-rationale">{it.rationale}</span>
                  {k?.rubric && <div className="muted">採点基準: {k.rubric}</div>}
                </div>
                {it.comment && s < it.max && (
                  <div className="result-note" data-testid="item-comment">
                    <strong>なぜ間違えたか</strong> {it.comment}
                  </div>
                )}
                {ex && s < it.max && (
                  <div className="explanation" data-testid="item-explanation">
                    <h3>考え方</h3>
                    <Md text={ex.thinking} />
                    <h3>解き方</h3>
                    <Md text={ex.solution} />
                    <h3>同じミスを防ぐ一言</h3>
                    <Md text={ex.tip} testId="item-tip" />
                  </div>
                )}
                <div className="row">
                  <button className="small" data-testid="ask-open" onClick={() => nav.go({ screen: 'chat', projectId, subjectId, testId, problemId: p.id })}>
                    この問題について質問する
                  </button>
                </div>
                <OverrideForm key={`${it.override?.at ?? ''}`} item={it} onSave={(score, note) => override(p.id, score, note)} />
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
