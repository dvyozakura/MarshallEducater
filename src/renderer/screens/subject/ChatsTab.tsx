import { useEffect, useState } from 'react';
import type { ChatListItem } from '../../../core/teach';
import { api, errorMessage } from '../../api';
import { Empty, ErrorBox } from '../../components';
import { useJobs } from '../../jobs';
import { useNav } from '../../nav';

function contextKind(c: ChatListItem['context']): string {
  return c.testId ? '問題について' : c.unitId ? '授業ノートについて' : '科目全般';
}

/** 科目の「質問」: これまでのやりとりの一覧と、新しい質問。 */
export function ChatsTab({ projectId, subjectId }: { projectId: string; subjectId: string }) {
  const nav = useNav();
  const [chats, setChats] = useState<ChatListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { jobs } = useJobs();
  const finished = jobs.filter((j) => j.kind === 'chat' && j.status !== 'queued' && j.status !== 'running').length;
  const answering = new Set(jobs.filter((j) => j.kind === 'chat' && (j.status === 'queued' || j.status === 'running')).map((j) => (j.params as { chatId?: string } | null)?.chatId));
  useEffect(() => {
    api.listChats(projectId, subjectId).then(setChats, (e) => setError(errorMessage(e)));
  }, [projectId, subjectId, finished]);

  return (
    <div data-testid="chats-tab">
      <div className="row">
        <button className="primary" data-testid="chat-new" onClick={() => nav.go({ screen: 'chat', projectId, subjectId })}>
          新しい質問
        </button>
        <span className="hint">問題についての質問は、採点結果の画面の「この問題について質問する」から。授業ノートについては、ノートの下のボタンから。</span>
      </div>
      <ErrorBox message={error} />
      {chats && chats.length === 0 && <Empty>まだ質問がありません。分からないことは、いつでも Claude に聞けます。</Empty>}
      {(chats ?? []).map((c) => (
        <div key={c.id} className="list-item clickable" data-testid="chat-row" onClick={() => nav.go({ screen: 'chat', projectId, subjectId, chatId: c.id })}>
          <span className="badge">{contextKind(c.context)}</span>
          <span className="grow">
            <strong>{c.title}</strong>{' '}
            <span className="muted">
              {Math.ceil(c.messages / 2)} 往復・{c.updatedAt.slice(0, 10)}
            </span>
          </span>
          {answering.has(c.id) ? (
            <span>
              <span className="spinner" /> 答えを待っています
            </span>
          ) : c.waiting ? (
            <span className="badge mid">答えがまだ</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
