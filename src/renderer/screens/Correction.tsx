import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { CorrectionView, ProblemPatch } from '../../core/correction';
import { ANSWER_FORMAT_LABEL, SOURCE_KIND_LABEL, SOURCE_STATUS_LABEL, type AnswerFormat, type BBox, type ExtractedProblem, type Figure } from '../../shared/schema';
import { api, errorMessage } from '../api';
import { Empty, ErrorBox, Md } from '../components';
import { JobRow, useJobRunner } from '../jobs';
import { useNav } from '../nav';
import { NotationButtons, verticalPreviewText } from '../notationButtons';
import { notationErrors } from '../../shared/notation';

interface Ids {
  projectId: string;
  subjectId: string;
  sourceId: string;
}

/** main からもらったバイト列を、画面で表示できる URL にする。 */
export function useBlobUrl(load: (() => Promise<Uint8Array>) | null, key: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    setUrl(null);
    if (!loadRef.current) return;
    loadRef.current().then(
      (bytes) => {
        if (!alive) return;
        made = URL.createObjectURL(new Blob([bytes.slice()], { type: 'image/png' }));
        setUrl(made);
      },
      () => {},
    );
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [key]);
  return url;
}

interface Draft {
  number: string;
  points: string;
  answerFormat: AnswerFormat;
  unit: string;
  target: string;
  body: string;
  choices: string;
}

function toDraft(p: ExtractedProblem): Draft {
  return { number: p.number, points: p.points === null ? '' : String(p.points), answerFormat: p.answerFormat, unit: p.unit, target: p.target ?? '', body: p.body, choices: p.choices.join('\n') };
}

function toPatch(d: Draft, answers: boolean): ProblemPatch {
  const pts = d.points.trim() === '' ? null : Number(d.points);
  const patch: ProblemPatch = {
    number: d.number,
    points: pts !== null && Number.isFinite(pts) ? pts : null,
    answerFormat: d.answerFormat,
    unit: d.unit,
    body: d.body,
    choices: d.choices
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  };
  if (answers) patch.target = d.target || null;
  return patch;
}

function FigureThumb({ ids, figure }: { ids: Ids; figure: Figure }) {
  const url = useBlobUrl(figure.image ? () => api.readFigureImage(ids.projectId, ids.subjectId, ids.sourceId, figure.image!) : null, figure.image ?? '');
  if (!url) return <span className="muted">(ページ {figure.page} の一部)</span>;
  return <img src={url} className="fig-thumb" alt={figure.description} data-testid="fig-thumb" />;
}

/** 左側: 元のページ画像。選んだ問題の図の範囲を重ねて表示し、ドラッグで範囲を指定できる。 */
function PagePane({
  ids,
  pages,
  pageNo,
  setPageNo,
  figures,
  drawing,
  onDrawn,
}: {
  ids: Ids;
  pages: number[];
  pageNo: number;
  setPageNo: (n: number) => void;
  figures: Figure[];
  drawing: boolean;
  onDrawn: (bbox: BBox) => void;
}) {
  const url = useBlobUrl(pages.includes(pageNo) ? () => api.readPageImage(ids.projectId, ids.subjectId, ids.sourceId, pageNo) : null, `${ids.sourceId}/${pageNo}`);
  const boxRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const pos = (e: ReactMouseEvent) => {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  const rect = drag ? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) } : null;
  const style = (b: BBox) => ({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
  const i = pages.indexOf(pageNo);
  return (
    <div className="corr-left" data-testid="page-pane">
      <div className="row">
        <button className="small" data-testid="page-prev" disabled={i <= 0} onClick={() => setPageNo(pages[i - 1])}>
          ← 前
        </button>
        <span data-testid="page-no">
          ページ {pageNo} / {pages.length}
        </span>
        <button className="small" data-testid="page-next" disabled={i < 0 || i >= pages.length - 1} onClick={() => setPageNo(pages[i + 1])}>
          次 →
        </button>
        {drawing && <span className="badge mid" data-testid="draw-hint">図の範囲を、ページの上でドラッグして囲んでください</span>}
      </div>
      <div
        className={`page-box ${drawing ? 'drawing' : ''}`}
        ref={boxRef}
        data-testid="page-box"
        onMouseDown={(e) => {
          if (!drawing) return;
          e.preventDefault();
          const p = pos(e);
          setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
        }}
        onMouseMove={(e) => {
          if (!drag) return;
          const p = pos(e);
          setDrag({ ...drag, x1: p.x, y1: p.y });
        }}
        onMouseUp={() => {
          if (rect && rect.w >= 0.01 && rect.h >= 0.01) onDrawn(rect);
          setDrag(null);
        }}
        onMouseLeave={() => setDrag(null)}
      >
        {url ? <img src={url} alt={`ページ ${pageNo}`} className="page-img" data-testid="page-img" draggable={false} /> : <div className="page-loading">読み込み中…</div>}
        {figures
          .filter((f) => f.page === pageNo)
          .map((f) => (
            <div key={f.id} className="fig-box" style={style(f.bbox)} data-testid="fig-box" title={f.description} />
          ))}
        {rect && <div className="fig-box new" style={style(rect)} />}
      </div>
    </div>
  );
}

/** 取り込み・補正画面: 左に元のページ、右に Claude の読み取り結果(編集できる)と数式のプレビュー。 */
export function Correction({ projectId, subjectId, sourceId }: Ids) {
  const nav = useNav();
  const ids = useMemo(() => ({ projectId, subjectId, sourceId }), [projectId, subjectId, sourceId]);
  const [view, setViewRaw] = useState<CorrectionView | null>(null);
  // main から新しい内容をもらうたびに進める番号。編集欄を入れ直す合図にする
  const [rev, setRev] = useState(0);
  const setView = useCallback((v: CorrectionView) => {
    setViewRaw(v);
    setRev((r) => r + 1);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftState, setDraftState] = useState<{ id: string; d: Draft } | null>(null);
  const [pageNo, setPageNo] = useState(1);
  const [drawFor, setDrawFor] = useState<{ figureId: string | null } | null>(null);
  const [hint, setHint] = useState('');
  const [uncCursor, setUncCursor] = useState(-1);
  const [confirmReread, setConfirmReread] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const pendingSelect = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const v = await api.getCorrectionView(projectId, subjectId, sourceId);
      setView(v);
      return v;
    } catch (e) {
      setError(errorMessage(e));
      return null;
    }
  }, [projectId, subjectId, sourceId, setView]);
  useEffect(() => {
    void load().then((v) => {
      if (v?.pages.length) setPageNo(v.pages[0]);
    });
  }, [load]);

  const reader = useJobRunner(() => void load());
  const rereader = useJobRunner(() => void load());

  const problems = view?.extracted?.problems ?? [];
  const selected = problems.find((p) => p.id === selectedId) ?? null;
  const answers = view?.source.kind === 'answer';
  // 編集欄の内容は、どの問題のものかと一緒に持つ(選び直した直後に、前の問題の内容を新しい問題へ書かないため)
  const draft = selected && draftState?.id === selected.id ? draftState.d : null;
  const setDraft = (d: Draft) => selected && setDraftState({ id: selected.id, d });
  const dirty = !!selected && !!draft && JSON.stringify(toDraft(selected)) !== JSON.stringify(draft);

  // 選んだ問題が変わったら(または保存・読み直しで中身が変わったら)、編集欄を入れ直す
  useEffect(() => {
    setDraftState(selected ? { id: selected.id, d: toDraft(selected) } : null);
    setConfirmDelete(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, rev]);

  // 「自信がない箇所へ飛ぶ」で選んだ文字列を、本文の中で選択状態にする
  useEffect(() => {
    const text = pendingSelect.current;
    const el = bodyRef.current;
    if (text === null || !el || !draft) return;
    pendingSelect.current = null;
    el.scrollIntoView({ block: 'center' });
    const at = text ? draft.body.indexOf(text) : -1;
    el.focus();
    if (at >= 0) el.setSelectionRange(at, at + text.length);
  }, [draft, selectedId, uncCursor]);

  const flush = async (): Promise<void> => {
    if (selected && draft && dirty) setView(await api.updateProblem(projectId, subjectId, sourceId, selected.id, toPatch(draft, answers)));
  };
  /** 編集中の内容を保存してから、操作を行う。 */
  const act = async (fn: () => Promise<CorrectionView | void>) => {
    setError(null);
    try {
      await flush();
      const v = await fn();
      if (v) setView(v);
    } catch (e) {
      setError(errorMessage(e));
      void load();
    }
  };
  const select = (p: ExtractedProblem | null) =>
    act(async () => {
      setSelectedId(p?.id ?? null);
      setDrawFor(null);
      if (p?.pages.length && view?.pages.includes(p.pages[0])) setPageNo(p.pages[0]);
    });

  const uncertainList = useMemo(() => problems.flatMap((p) => p.uncertain.map((u, index) => ({ problemId: p.id, index, text: u.text }))), [problems]);
  const jumpUncertain = () => {
    if (uncertainList.length === 0) return;
    const next = (uncCursor + 1) % uncertainList.length;
    const u = uncertainList[next];
    const p = problems.find((q) => q.id === u.problemId)!;
    void select(p).then(() => {
      pendingSelect.current = u.text;
      setUncCursor(next);
    });
  };

  if (!view) return <div className="page"><ErrorBox message={error} />{!error && '読み込み中…'}</div>;

  const src = view.source;
  const vertical = view.writingMode === 'vertical';
  const confirmedCount = problems.filter((p) => p.confirmed).length;
  const rate = view.stats.originalChars > 0 ? Math.round((view.stats.changedChars / view.stats.originalChars) * 1000) / 10 : 0;
  const startRead = () => void reader.start(() => api.startReadSource(projectId, subjectId, sourceId));
  const backToList = () => nav.go({ screen: 'subject', projectId, subjectId, tab: src.testId ? 'tests' : 'sources' });

  return (
    <div className="page wide" data-testid="screen-correction">
      <div className="row">
        <h1 data-testid="corr-title">{src.title}</h1>
        <span className="badge">{SOURCE_KIND_LABEL[src.kind]}</span>
        <span className={`badge ${src.status === 'confirmed' ? 'good' : src.status === 'read' ? 'mid' : ''}`} data-testid="corr-status">
          {SOURCE_STATUS_LABEL[src.status]}
        </span>
        <span className="spacer" />
        <button data-testid="corr-back" onClick={() => void act(async () => backToList())}>
          {src.testId ? '科目の画面へ' : '資料の一覧へ'}
        </button>
      </div>
      <ErrorBox message={error ?? reader.startError ?? rereader.startError} testId="corr-error" />

      <div className="corr">
        <PagePane
          ids={ids}
          pages={view.pages}
          pageNo={pageNo}
          setPageNo={setPageNo}
          figures={selected?.figures ?? []}
          drawing={!!drawFor}
          onDrawn={(bbox) => {
            if (!selected || !drawFor) return;
            const figureId = drawFor.figureId;
            setDrawFor(null);
            void act(() => api.saveFigure(projectId, subjectId, sourceId, selected.id, { id: figureId, page: pageNo, bbox }));
          }}
        />

        <div className="corr-right" data-testid="corr-right">
          {!view.extracted ? (
            <div data-testid="not-read">
              <Empty>
                まだ読み取っていません。Claude がページ画像を読み、{answers ? '答案を設問ごと' : '問題ごと'}に書き起こします(数分かかることがあります。待っている間も他の画面を使えます)。
              </Empty>
              <div className="buttons">
                <button className="primary" data-testid="read-start" disabled={reader.busy} onClick={startRead}>
                  Claude に読み取らせる
                </button>
              </div>
              {reader.job && <JobRow job={reader.job} onRetry={startRead} />}
            </div>
          ) : (
            <>
              <div className="corr-bar">
                <span data-testid="corr-count">
                  {problems.length} 件(確定 {confirmedCount})
                </span>
                <button className="small" data-testid="next-uncertain" disabled={uncertainList.length === 0} onClick={jumpUncertain}>
                  自信がない箇所へ(残り {uncertainList.length})
                </button>
                <span className="muted" data-testid="corr-stats" title="Claude の読み取りを、人がどれだけ直したかの目安">
                  直した割合 {rate}%(操作 {view.stats.edits} 回)
                </span>
                <span className="spacer" />
                {src.status === 'confirmed' ? (
                  <button data-testid="unconfirm-source" onClick={() => void act(() => api.unconfirmSource(projectId, subjectId, sourceId))}>
                    確定を取り消す
                  </button>
                ) : (
                  <button className="primary" data-testid="confirm-source" disabled={problems.length === 0} onClick={() =>
                      void act(async () => {
                        const v = await api.confirmSource(projectId, subjectId, sourceId);
                        // 過去問が確定したら、志望校の傾向をまとめ直す(裏で進む)
                        if (v.source.kind === 'past_exam') await api.startUpdateTrend(projectId, subjectId).catch(() => {});
                        return v;
                      })
                    }
                  >
                    この{answers ? '答案' : '資料'}を確定する
                  </button>
                )}
              </div>
              {src.status === 'confirmed' ? (
                <div className="info" data-testid="source-confirmed">
                  確定済みです。{answers ? '採点に使われます。' : '傾向の分析や類題づくりに使われます。'}内容を直すと、確定は外れます。
                  {src.kind === 'past_exam' && (
                    <div className="buttons">
                      <button data-testid="go-trend" onClick={() => nav.go({ screen: 'subject', projectId, subjectId, tab: 'trend' })}>
                        志望校の傾向を見る
                      </button>
                    </div>
                  )}
                  {src.testId && (
                    <div className="buttons">
                      <button className="primary" data-testid="go-grade" onClick={() => void api.startGrade(projectId, subjectId, src.testId!).catch(() => {}).then(() => nav.go({ screen: 'result', projectId, subjectId, testId: src.testId! }))}>
                        採点へ進む
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="hint">確定するまでは、{answers ? '採点' : '傾向の分析や類題づくり'}に使われません。元のページと見比べて、違うところを直してください。</div>
              )}
              {reader.job && reader.job.status !== 'done' && <JobRow job={reader.job} onRetry={startRead} />}
              {rereader.job && rereader.job.status !== 'done' && <JobRow job={rereader.job} />}

              {problems.length === 0 && <Empty>問題が1つも読み取れませんでした。下の「全体を読み取り直す」を試してください。</Empty>}
              {problems.map((p, i) => {
                const isSel = p.id === selectedId;
                return (
                  <div key={p.id} className={`pcard ${isSel ? 'selected' : ''} ${p.uncertain.length ? 'uncertain' : ''} ${p.confirmed ? 'confirmed' : ''}`} data-testid="pcard" data-problem-id={p.id} data-confirmed={p.confirmed}>
                    <div className="pcard-head" data-testid="pcard-head" onClick={() => void select(isSel ? null : p)}>
                      <strong data-testid="pcard-number">{p.number || '(番号なし)'}</strong>
                      <span className="badge">{ANSWER_FORMAT_LABEL[p.answerFormat]}</span>
                      {p.points !== null && <span className="muted">{p.points} 点</span>}
                      {answers && <span className={`badge ${p.target ? '' : 'low'}`}>{p.target ? `→ ${p.target}` : '設問が未定'}</span>}
                      {p.uncertain.length > 0 && (
                        <span className="badge mid" data-testid="pcard-uncertain">
                          自信なし {p.uncertain.length}
                        </span>
                      )}
                      {p.confirmed && <span className="badge good">確定</span>}
                      <span className="spacer" />
                      <span className="muted">p.{p.pages.join(',') || '?'}</span>
                    </div>
                    {!isSel && <Md text={p.body.length > 300 ? `${p.body.slice(0, 300)}…` : p.body} className="pcard-body" />}
                    {isSel && draft && (
                      <div className="pcard-edit" data-testid="pcard-edit">
                        <div className="row">
                          <label>
                            番号 <input data-testid="c-number" value={draft.number} onChange={(e) => setDraft({ ...draft, number: e.target.value })} style={{ width: 130 }} />
                          </label>
                          {!answers && (
                            <label>
                              配点 <input data-testid="c-points" value={draft.points} onChange={(e) => setDraft({ ...draft, points: e.target.value })} style={{ width: 60 }} />
                            </label>
                          )}
                          <label>
                            形式{' '}
                            <select data-testid="c-format" value={draft.answerFormat} onChange={(e) => setDraft({ ...draft, answerFormat: e.target.value as AnswerFormat })}>
                              {(Object.keys(ANSWER_FORMAT_LABEL) as AnswerFormat[]).map((k) => (
                                <option key={k} value={k}>
                                  {ANSWER_FORMAT_LABEL[k]}
                                </option>
                              ))}
                            </select>
                          </label>
                          {answers ? (
                            <label>
                              どの設問への解答か{' '}
                              <select data-testid="c-target" value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })}>
                                <option value="">(未定)</option>
                                {(view.targets ?? []).map((t) => (
                                  <option key={t.number} value={t.number}>
                                    {t.number} {t.summary.slice(0, 20)}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : (
                            <label>
                              単元{' '}
                              <select data-testid="c-unit" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} style={{ maxWidth: 240 }}>
                                <option value="">(なし)</option>
                                {view.units.map((u) => (
                                  <option key={u.id} value={u.id}>
                                    {u.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </div>
                        <div className={vertical ? 'split-v' : 'split'}>
                          <div>
                            <div className="hint">
                              {answers ? '答案の内容' : '本文'}(Markdown。数式は $…$、$$…$${vertical ? '。縦書きの記法は「記法」ボタンか一覧を参照' : ''})
                            </div>
                            {vertical && <NotationButtons target={bodyRef} onChange={(body) => setDraft({ ...draft, body })} />}
                            <textarea data-testid="c-body" ref={bodyRef} rows={9} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
                            {notationErrors(draft.body).map((m) => (
                              <div key={m} className="warn small" data-testid="c-notation-error">
                                ⚠ {m}
                              </div>
                            ))}
                            {!answers && (
                              <>
                                <div className="hint">選択肢(1行に1つ)</div>
                                <textarea data-testid="c-choices" rows={Math.max(2, draft.choices.split('\n').length)} value={draft.choices} onChange={(e) => setDraft({ ...draft, choices: e.target.value })} />
                              </>
                            )}
                          </div>
                          <div>
                            <div className="hint">表示の確認(プレビュー{vertical ? '・縦書き。左の元のページと見比べてください' : ''})</div>
                            <div className="preview" data-testid="c-preview">
                              {vertical ? (
                                <Md text={verticalPreviewText(draft.body, draft.choices)} vertical testId="c-preview-tate" height="420px" />
                              ) : (
                                <Md text={draft.body} />
                              )}
                              {!vertical && draft.choices.trim() && (
                                <ol className="choices">
                                  {draft.choices
                                    .split('\n')
                                    .filter((s) => s.trim())
                                    .map((c, n) => (
                                      <li key={n}>
                                        <Md text={c} />
                                      </li>
                                    ))}
                                </ol>
                              )}
                            </div>
                          </div>
                        </div>

                        {p.uncertain.length > 0 && (
                          <div className="unc-list" data-testid="unc-list">
                            {p.uncertain.map((u, n) => (
                              <div key={n} className="unc" data-testid="unc-item">
                                <span className="badge mid">自信なし</span>
                                {u.text && <code>{u.text}</code>}
                                <span>{u.reason}</span>
                                <button className="small" data-testid="unc-resolve" onClick={() => void act(() => api.resolveUncertain(projectId, subjectId, sourceId, p.id, n))}>
                                  確かめた
                                </button>
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="fig-list">
                          {p.figures.map((f) => (
                            <div key={f.id} className="fig-item" data-testid="fig-item">
                              <FigureThumb ids={ids} figure={f} />
                              <div className="grow">
                                <div className="muted">
                                  図(ページ {f.page}、左 {Math.round(f.bbox.x * 100)}% 上 {Math.round(f.bbox.y * 100)}% 幅 {Math.round(f.bbox.w * 100)}% 高さ {Math.round(f.bbox.h * 100)}%)
                                </div>
                                <textarea
                                  data-testid="fig-desc"
                                  rows={2}
                                  defaultValue={f.description}
                                  onBlur={(e) => {
                                    const description = e.target.value;
                                    if (description !== f.description) void act(() => api.saveFigure(projectId, subjectId, sourceId, p.id, { id: f.id, page: f.page, bbox: f.bbox, description }));
                                  }}
                                />
                              </div>
                              <button
                                className="small"
                                data-testid="fig-redraw"
                                onClick={() => {
                                  setPageNo(f.page);
                                  setDrawFor({ figureId: f.id });
                                }}
                              >
                                範囲を直す
                              </button>
                              <button className="small danger" data-testid="fig-delete" onClick={() => void act(() => api.deleteFigure(projectId, subjectId, sourceId, p.id, f.id))}>
                                図を消す
                              </button>
                            </div>
                          ))}
                        </div>

                        <div className="buttons">
                          <button className="primary" data-testid="c-save" disabled={!dirty} onClick={() => void act(async () => {})}>
                            変更を保存
                          </button>
                          {p.confirmed ? (
                            <button data-testid="c-unconfirm" onClick={() => void act(() => api.confirmProblem(projectId, subjectId, sourceId, p.id, false))}>
                              確定を外す
                            </button>
                          ) : (
                            <button data-testid="c-confirm" onClick={() => void act(() => api.confirmProblem(projectId, subjectId, sourceId, p.id, true))}>
                              この{answers ? '解答' : '問題'}を確定
                            </button>
                          )}
                          <button
                            className="small"
                            data-testid="c-split"
                            title="本文の中で、分けたい位置にカーソルを置いてから押します"
                            onClick={() => {
                              const at = bodyRef.current?.selectionStart ?? 0;
                              void act(() => api.splitProblem(projectId, subjectId, sourceId, p.id, at));
                            }}
                          >
                            カーソルの位置で分ける
                          </button>
                          <button className="small" data-testid="c-merge" disabled={i >= problems.length - 1} onClick={() => void act(() => api.mergeWithNext(projectId, subjectId, sourceId, p.id))}>
                            次とつなげる
                          </button>
                          <button className="small" data-testid="c-up" disabled={i === 0} onClick={() => void act(() => api.moveProblem(projectId, subjectId, sourceId, p.id, -1))}>
                            ↑ 前へ
                          </button>
                          <button className="small" data-testid="c-down" disabled={i >= problems.length - 1} onClick={() => void act(() => api.moveProblem(projectId, subjectId, sourceId, p.id, 1))}>
                            ↓ 後ろへ
                          </button>
                          <button className="small" data-testid="fig-add" onClick={() => setDrawFor({ figureId: null })}>
                            図を足す
                          </button>
                          {confirmDelete ? (
                            <>
                              <button
                                className="small danger"
                                data-testid="c-delete-yes"
                                onClick={() => {
                                  setDraft(toDraft(p)); // 消すものは保存しない
                                  setError(null);
                                  api.deleteProblem(projectId, subjectId, sourceId, p.id).then(
                                    (v) => {
                                      setSelectedId(null);
                                      setView(v);
                                    },
                                    (e) => setError(errorMessage(e)),
                                  );
                                }}
                              >
                                本当に消す
                              </button>
                              <button className="small" onClick={() => setConfirmDelete(false)}>
                                やめる
                              </button>
                            </>
                          ) : (
                            <button className="small danger" data-testid="c-delete" onClick={() => setConfirmDelete(true)}>
                              消す
                            </button>
                          )}
                        </div>
                        <div className="row reread">
                          <input data-testid="reread-hint" value={hint} onChange={(e) => setHint(e.target.value)} placeholder="ここを読み直して(例: 2行目の分数は 3/4 ではなく 3/5)" style={{ flex: 1, minWidth: 240 }} />
                          <button
                            data-testid="reread"
                            disabled={rereader.busy}
                            onClick={() =>
                              void act(async () => {
                                void rereader.start(() => api.startRereadProblem(projectId, subjectId, sourceId, p.id, hint)).then((j) => j?.status === 'done' && setHint(''));
                              })
                            }
                          >
                            Claude に読み直させる
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="buttons">
                {confirmReread ? (
                  <>
                    <span className="hint">いまの読み取り結果と、直した内容は消えます。</span>
                    <button
                      className="danger"
                      data-testid="read-again-yes"
                      onClick={() => {
                        setConfirmReread(false);
                        setSelectedId(null);
                        startRead();
                      }}
                    >
                      読み取り直す
                    </button>
                    <button onClick={() => setConfirmReread(false)}>やめる</button>
                  </>
                ) : (
                  <button className="small" data-testid="read-again" disabled={reader.busy} onClick={() => setConfirmReread(true)}>
                    全体を読み取り直す
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
