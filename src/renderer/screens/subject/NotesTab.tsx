import { useEffect, useState } from 'react';
import type { NoteInfo } from '../../../core/teach';
import { api, errorMessage } from '../../api';
import { Empty, ErrorBox, Md, Meter, Section } from '../../components';
import { JobRow, useJobs } from '../../jobs';
import { useNav } from '../../nav';

/** 科目の「授業ノート」: 単元ごとに Claude が書くノート(要点・例題・よくある誤り)。 */
export function NotesTab({ projectId, subjectId }: { projectId: string; subjectId: string }) {
  const nav = useNav();
  const [notes, setNotes] = useState<NoteInfo[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState<{ unitId: string; unitName: string; markdown: string; updatedAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { jobs } = useJobs();
  const mine = jobs.filter((j) => j.kind === 'create_note' && j.projectId === projectId && (j.params as { subjectId?: string } | null)?.subjectId === subjectId);
  const unitOf = (j: (typeof mine)[number]) => (j.params as { unitId?: string } | null)?.unitId;
  const busy = (unitId: string) => mine.some((j) => unitOf(j) === unitId && (j.status === 'queued' || j.status === 'running'));
  const failed = mine.filter((j) => j.status === 'failed' && !mine.some((k) => unitOf(k) === unitOf(j) && k.createdAt > j.createdAt));
  const finished = mine.filter((j) => j.status === 'done').length;

  useEffect(() => {
    api.listNotes(projectId, subjectId).then(setNotes, (e) => setError(errorMessage(e)));
  }, [projectId, subjectId, finished]);
  useEffect(() => {
    if (!openId) return setNote(null);
    api.getNote(projectId, subjectId, openId).then(setNote, (e) => setError(errorMessage(e)));
  }, [projectId, subjectId, openId, finished]);

  const create = (unitId: string) => {
    setError(null);
    setOpenId(unitId);
    void api.startCreateNote(projectId, subjectId, unitId).catch((e) => setError(errorMessage(e)));
  };

  return (
    <div data-testid="notes-tab">
      <div className="hint">単元ごとに、Claude が要点・例題・よくある誤りをまとめた授業ノートを書きます(1つにつき数分)。習熟度の低い単元が上に並びます。</div>
      <ErrorBox message={error} />
      {failed.map((j) => (
        <JobRow key={j.id} job={j} onRetry={() => void api.retryJob(j.id).catch((e) => setError(errorMessage(e)))} />
      ))}

      {openId && (
        <Section
          title={note ? note.unitName : '授業ノート'}
          testId="note-view"
          actions={
            <>
              {note && (
                <button className="small" data-testid="note-ask" onClick={() => nav.go({ screen: 'chat', projectId, subjectId, unitId: openId })}>
                  このノートについて質問する
                </button>
              )}
              <button className="small" data-testid="note-close" onClick={() => setOpenId(null)}>
                閉じる
              </button>
            </>
          }
        >
          {busy(openId) && (
            <div data-testid="note-creating">
              <span className="spinner" /> Claude がノートを書いています…(待っている間も他の画面を使えます)
            </div>
          )}
          {note && (
            <>
              <div className="muted">更新: {note.updatedAt.slice(0, 10)}</div>
              <Md text={note.markdown} className="note-body" testId="note-body" />
            </>
          )}
          {!note && !busy(openId) && <div className="muted">この単元のノートは、まだありません。</div>}
        </Section>
      )}

      {notes && notes.length === 0 && <Empty>出題の対象の単元がありません。「単元」タブで確かめてください。</Empty>}
      {(notes ?? []).map((n) => (
        <div key={n.unitId} className="list-item" data-testid="note-row" data-unit-id={n.unitId} data-has-note={n.hasNote}>
          <span className="grow">
            <strong>{n.unitName}</strong>{' '}
            {n.mastery !== null && (
              <span className="muted">
                習熟度 {n.mastery} <Meter value={n.mastery} />
              </span>
            )}
          </span>
          {n.hasNote && <span className="badge good">ノートあり・{n.updatedAt?.slice(0, 10)}</span>}
          {busy(n.unitId) ? (
            <span>
              <span className="spinner" /> 作っています
            </span>
          ) : n.hasNote ? (
            <>
              <button className="small primary" data-testid="note-open" onClick={() => setOpenId(n.unitId)}>
                読む
              </button>
              <button className="small" data-testid="note-recreate" onClick={() => create(n.unitId)}>
                作り直す
              </button>
            </>
          ) : (
            <button className="small" data-testid="note-create" onClick={() => create(n.unitId)}>
              ノートを作る
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
