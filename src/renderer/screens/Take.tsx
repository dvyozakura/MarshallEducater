import { useCallback, useEffect, useRef, useState } from 'react';
import type { TakeView } from '../../core/answers';
import { choiceMark } from '../../shared/labels';
import { DIFFICULTY_LABEL, PROBLEM_FORMAT_LABEL, TEST_KIND_LABEL, type Problem } from '../../shared/schema';
import { api, errorMessage } from '../api';
import { ErrorBox, Md, Section, SvgFigure, MadeByTag } from '../components';
import { useNav } from '../nav';
import { PdfButtons } from './subject/TestsTab';

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function AnswerInput({ p, value, onChange, disabled }: { p: Problem; value: string; onChange: (v: string) => void; disabled: boolean }) {
  if (p.format === 'choice') {
    return (
      <div className="take-choices">
        {p.choices.map((c, i) => (
          <label key={i} className={`take-choice ${value === String(i + 1) ? 'on' : ''}`} data-testid={`choice-${i + 1}`}>
            <input type="radio" name={`ans-${p.id}`} checked={value === String(i + 1)} disabled={disabled} onChange={() => onChange(String(i + 1))} />
            <span className="mark">{choiceMark(i)}</span>
            <Md text={c} />
          </label>
        ))}
        {value && !disabled && (
          <button className="link" onClick={() => onChange('')}>
            選択を取り消す
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="split">
      <div>
        <div className="hint">{p.format === 'short' ? '答え' : '考え方と答え'}(数式は $…$ で囲むと LaTeX で書けます)</div>
        {p.format === 'short' ? (
          <input data-testid="take-short" style={{ width: '100%' }} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <textarea data-testid="take-essay" rows={7} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
        )}
      </div>
      <div>
        <div className="hint">表示の確認</div>
        <div className="preview" data-testid="take-preview">
          <Md text={value} />
        </div>
      </div>
    </div>
  );
}

/** テストを解く画面(アプリ内で、制限時間つき)。 */
export function Take({ projectId, subjectId, testId }: { projectId: string; subjectId: string; testId: string }) {
  const nav = useNav();
  const [view, setView] = useState<TakeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [elapsed, setElapsed] = useState(0);
  const [extended, setExtended] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const state = useRef({ answers, elapsed, extended, started, done: false });
  state.current = { ...state.current, answers, elapsed, extended, started };

  useEffect(() => {
    void (async () => {
      try {
        setSpeed((await api.appInfo()).timerSpeed);
        const v = await api.getTakeView(projectId, subjectId, testId);
        setView(v);
        if (v.draft) {
          setAnswers(v.draft.answers);
          setElapsed(v.draft.elapsedSec);
          setExtended(v.draft.extended);
          setStarted(true);
        }
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
  }, [projectId, subjectId, testId]);

  const limitSec = (view?.test.timeLimitMin ?? 0) * 60;
  const timeUp = started && elapsed >= limitSec && !extended;

  // 時計: 始めてから、時間切れで止まるまで(延長したら進み続ける)
  useEffect(() => {
    if (!started || timeUp || submitting) return;
    const t = setInterval(() => setElapsed((e) => e + speed), 1000);
    return () => clearInterval(t);
  }, [started, timeUp, speed, submitting]);

  const save = useCallback(async () => {
    const s = state.current;
    if (!s.started || s.done) return;
    await api.saveDraft(projectId, subjectId, testId, { answers: s.answers, elapsedSec: s.elapsed, extended: s.extended }).catch(() => {});
  }, [projectId, subjectId, testId]);

  // 途中の控え: 入力が止まって少ししたら保存。時間は 10 秒ごと。画面を離れるときにも保存する
  useEffect(() => {
    if (!started) return;
    const t = setTimeout(() => void save(), 400);
    return () => clearTimeout(t);
  }, [answers, extended, started, save]);
  const tenSec = Math.floor(elapsed / 10);
  useEffect(() => {
    if (started) void save();
  }, [tenSec, started, save]);
  useEffect(() => () => void save(), [save]);

  if (!view) return <div className="page"><ErrorBox message={error} />{!error && '読み込み中…'}</div>;
  const { test } = view;
  const at = { projectId, subjectId, testId };
  const total = test.problems.reduce((n, p) => n + p.points, 0);
  const answered = test.problems.filter((p) => (answers[p.id] ?? '').trim()).length;

  if (test.status !== 'ready') {
    return (
      <div className="page narrow" data-testid="screen-take">
        <Section title={test.title}>
          <div className="info" data-testid="take-already">このテストの答案は、もう出されています。</div>
          <div className="buttons">
            <button className="primary" onClick={() => nav.go(test.status === 'reading' ? { screen: 'correction', projectId, subjectId, sourceId: `sub-${testId}` } : { screen: 'result', ...at })}>
              {test.status === 'reading' ? '答案の読み取りを確かめる' : '結果を見る'}
            </button>
          </div>
        </Section>
      </div>
    );
  }

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      state.current.done = true;
      await api.submitAnswers(projectId, subjectId, testId, { answers, elapsedSec: elapsed });
      // 出したら、そのまま採点を始める(結果の画面で進み具合が見える)
      await api.startGrade(projectId, subjectId, testId).catch(() => {});
      nav.go({ screen: 'result', ...at });
    } catch (e) {
      state.current.done = false;
      setError(errorMessage(e));
      setSubmitting(false);
    }
  };

  if (!started) {
    return (
      <div className="page narrow" data-testid="screen-take">
        <Section title={test.title}>
          <div data-testid="take-summary">
            {TEST_KIND_LABEL[test.kind]} ・ {test.problems.length} 問 ・ {total} 点 ・ 制限時間 {test.timeLimitMin} 分 <MadeByTag madeBy={test.madeBy} what="問題" testId="madeby-test" />
          </div>
          {test.instructions && <div className="info">{test.instructions}</div>}
          <div className="hint">「始める」を押すと時計が動きます。途中で他の画面に移っても、入力した内容と使った時間は残ります。</div>
          <div className="buttons">
            <button className="primary" data-testid="take-start" onClick={() => setStarted(true)}>
              始める
            </button>
            <button data-testid="take-paper" onClick={() => nav.go({ screen: 'import', ...at })}>
              紙で解いた答案を出す
            </button>
            <PdfButtons {...at} />
          </div>
        </Section>
      </div>
    );
  }

  const remaining = limitSec - elapsed;
  return (
    <div className="page" data-testid="screen-take">
      <div className="take-bar">
        <strong>{test.title}</strong>
        <span className={`take-timer ${remaining < 300 ? 'low' : ''}`} data-testid="take-timer">
          {remaining >= 0 ? `残り ${clock(remaining)}` : `制限時間を ${clock(-remaining)} 超過`}
        </span>
        <span data-testid="take-progress">
          回答済み {answered} / {test.problems.length}
        </span>
        <span className="spacer" />
        {confirming ? (
          <>
            <span data-testid="take-unanswered">{answered < test.problems.length ? `未回答が ${test.problems.length - answered} 問あります。` : ''}提出しますか?(出し直しはできません)</span>
            <button className="primary" data-testid="take-submit-yes" disabled={submitting} onClick={() => void submit()}>
              提出する
            </button>
            <button disabled={submitting} onClick={() => setConfirming(false)}>
              戻る
            </button>
          </>
        ) : (
          <button className="primary" data-testid="take-submit" onClick={() => setConfirming(true)}>
            答案を提出する
          </button>
        )}
      </div>
      <ErrorBox message={error} />
      {timeUp && (
        <div className="notice" data-testid="take-timeup">
          <strong>制限時間になりました。</strong> ここまでの答案を提出してください。続けたい場合は、時間を延ばせます(かかった時間は記録され、採点の参考にされます)。
          <div className="buttons">
            <button data-testid="take-extend" onClick={() => setExtended(true)}>
              時間を延ばして続ける
            </button>
          </div>
        </div>
      )}
      {test.problems.map((p) => (
        <section key={p.id} className="section take-problem" data-testid="take-problem" data-problem-id={p.id}>
          <div className="row">
            <h2>{p.number}</h2>
            <span className="muted">
              {p.points} 点・{PROBLEM_FORMAT_LABEL[p.format]}・{DIFFICULTY_LABEL[p.difficulty]}
            </span>
          </div>
          <Md text={p.body} testId="take-body" />
          <SvgFigure svg={p.figureSvg} />
          <AnswerInput p={p} value={answers[p.id] ?? ''} disabled={timeUp || submitting} onChange={(v) => setAnswers((a) => ({ ...a, [p.id]: v }))} />
        </section>
      ))}
    </div>
  );
}
