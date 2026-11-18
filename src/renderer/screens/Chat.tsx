import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatView } from '../../core/teach';
import { choiceMark } from '../../shared/labels';
import { api, errorMessage } from '../api';
import { ErrorBox, Md, Section, SvgFigure } from '../components';
import { JobRow, useJobs } from '../jobs';
import { useNav } from '../nav';

interface Props {
  projectId: string;
  subjectId: string;
  chatId?: string;
  testId?: string;
  problemId?: string;
  unitId?: string;
}

/** 質問の画面。問題・授業ノート・科目全般について Claude に質問し、続きのやりとりができる。 */
export function Chat({ projectId, subjectId, chatId: initialChatId, testId, problemId, unitId }: Props) {
  const nav = useNav();
  const [chatId, setChatId] = useState<string | null>(initialChatId ?? null);
  const [view, setView] = useState<ChatView | null>(null);
  const [preview, setPreview] = useState<Omit<ChatView, 'chat'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const { jobs } = useJobs();
  const bottom = useRef<HTMLDivElement>(null);

  const mine = chatId ? jobs.filter((j) => j.kind === 'chat' && (j.params as { chatId?: string } | null)?.chatId === chatId) : [];
  const job = mine.at(-1) ?? null;
  const busy = !!job && (job.status === 'queued' || job.status === 'running');
  const finished = mine.filter((j) => j.status !== 'queued' && j.status !== 'running').length;

  const load = useCallback(() => {
    if (chatId) return api.getChatView(projectId, subjectId, chatId).then(setView, (e) => setError(errorMessage(e)));
    return api.previewChatContext(projectId, subjectId, { testId: testId ?? null, problemId: problemId ?? null, unitId: unitId ?? null }).then(setPreview, (e) => setError(errorMessage(e)));
  }, [projectId, subjectId, chatId, testId, problemId, unitId]);
  useEffect(() => {
    void load();
  }, [load, finished]);
  const count = view?.chat.messages.length ?? 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [count, busy]);

  const info = view ?? preview;
  const messages = view?.chat.messages ?? [];
  const waiting = messages.at(-1)?.role === 'user';

  const send = async () => {
    const question = text.trim();
    if (!question || sending || busy) return;
    setSending(true);
    setError(null);
    try {
      const r = await api.askQuestion(projectId, subjectId, { chatId, context: { testId: testId ?? null, problemId: problemId ?? null, unitId: unitId ?? null }, question });
      setText('');
      setChatId(r.chatId);
      if (r.chatId === chatId) await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };
  const retry = () => {
    if (job) void api.retryJob(job.id).catch((e) => setError(errorMessage(e)));
  };

  return (
    <div className="page" data-testid="screen-chat">
      <div className="row">
        <h1>質問</h1>
        <span className="muted" data-testid="chat-context">
          {info?.contextLabel ?? ''}
        </span>
        <span className="spacer" />
        <button data-testid="chat-list" onClick={() => nav.go({ screen: 'subject', projectId, subjectId, tab: 'chats' })}>
          質問の一覧へ
        </button>
        <button data-testid="chat-back" onClick={() => nav.back()}>
          戻る
        </button>
      </div>
      <ErrorBox message={error} />

      {info?.problem && (
        <details className="section chat-problem" data-testid="chat-problem" open={messages.length === 0}>
          <summary>
            {info.problem.number}({info.problem.unitName})の問題文
          </summary>
          <Md text={info.problem.body} />
          <SvgFigure svg={info.problem.figureSvg} />
          {info.problem.choices.length > 0 && (
            <ol className="choices plain">
              {info.problem.choices.map((c, i) => (
                <li key={i}>
                  <span>{choiceMark(i)}</span> <Md text={c} />
                </li>
              ))}
            </ol>
          )}
        </details>
      )}

      <Section title="やりとり" testId="chat-thread">
        {messages.length === 0 && (
          <div className="hint" data-testid="chat-empty">
            分からないところを、そのまま書いてください。Claude には、この問題・あなたの答案・採点・苦手マップを一緒に渡します(答えが出るまで数十秒〜数分かかります)。
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`} data-testid="chat-msg" data-role={m.role}>
            <div className="chat-who">{m.role === 'user' ? 'あなた' : 'Claude'}</div>
            {m.role === 'user' ? <div className="chat-text">{m.text}</div> : <Md text={m.text} />}
          </div>
        ))}
        {busy && (
          <div className="chat-msg assistant pending" data-testid="chat-pending">
            <span className="spinner" /> Claude が答えを書いています…
          </div>
        )}
        {waiting && !busy && job && job.status !== 'done' && <JobRow job={job} onRetry={retry} />}
        {waiting && !busy && !job && (
          <div className="hint" data-testid="chat-unanswered">
            この質問には、まだ答えが付いていません。同じ質問をもう一度送ってください。
          </div>
        )}
        <div ref={bottom} />
      </Section>

      <div className="chat-input">
        <textarea
          data-testid="chat-input"
          value={text}
          rows={3}
          placeholder="質問を書く(数式は $x^2$ のように書けます)。Ctrl+Enter で送信"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
          }}
        />
        <button className="primary" data-testid="chat-send" disabled={!text.trim() || sending || busy} onClick={() => void send()}>
          質問する
        </button>
      </div>
      {text.includes('$') && (
        <div className="preview" data-testid="chat-preview">
          <Md text={text} />
        </div>
      )}
    </div>
  );
}
