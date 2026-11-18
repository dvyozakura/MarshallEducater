import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatView } from '../../core/teach';
import { api, errorMessage } from '../api';
import { ErrorBox, Md } from '../components';
import { JobRow, useJobs } from '../jobs';
import { useNav } from '../nav';

interface Props {
  projectId: string;
  subjectId: string;
  /** 章についての質問ならその単元 ID。null なら、章を指定しない科目全体についての質問。 */
  chapterUnitId: string | null;
  /** 「ここを質問」で選んだ箇所。 */
  quote?: string | null;
  onClearQuote?: () => void;
  /** 「教材に反映」を出すか(章が作ってあるとき)。 */
  canSupplement?: boolean;
  /** 入力欄に移るための合図(値が変わるたびに入力欄へ移る)。 */
  focusKey?: number;
}

/**
 * 教材への質問欄。会話は章ごと(または科目全体で1つ)に保存し、開き直すと続きができる。
 * 仕組みは「質問」(teach.ts の postQuestion / answerChat)をそのまま使う。
 */
export function TextbookChat({ projectId, subjectId, chapterUnitId, quote = null, onClearQuote, canSupplement = false, focusKey = 0 }: Props) {
  const nav = useNav();
  const [chatId, setChatId] = useState<string | null>(null);
  const [view, setView] = useState<ChatView | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const { jobs } = useJobs();

  const chatJobs = chatId ? jobs.filter((j) => j.kind === 'chat' && (j.params as { chatId?: string } | null)?.chatId === chatId) : [];
  const job = chatJobs.at(-1) ?? null;
  const busy = !!job && (job.status === 'queued' || job.status === 'running');
  const supJobs = chatId ? jobs.filter((j) => j.kind === 'chapter_supplement' && (j.params as { chatId?: string } | null)?.chatId === chatId) : [];
  const supJob = supJobs.at(-1) ?? null;
  const supBusy = !!supJob && (supJob.status === 'queued' || supJob.status === 'running');
  const finished = [...chatJobs, ...supJobs].filter((j) => j.status !== 'queued' && j.status !== 'running').length;

  // 章が変わったら、その章のいちばん新しいやりとりを開く
  useEffect(() => {
    setChatId(null);
    setView(null);
    setFresh(false);
    setError(null);
    api.findTextbookChat(projectId, subjectId, chapterUnitId).then(
      (v) => {
        setView(v);
        setChatId(v?.chat.id ?? null);
      },
      (e) => setError(errorMessage(e)),
    );
  }, [projectId, subjectId, chapterUnitId]);

  const load = useCallback(() => {
    if (!chatId) return Promise.resolve();
    return api.getChatView(projectId, subjectId, chatId).then(setView, (e) => setError(errorMessage(e)));
  }, [projectId, subjectId, chatId]);
  useEffect(() => {
    void load();
  }, [load, finished]);

  useEffect(() => {
    if (focusKey > 0) input.current?.focus();
  }, [focusKey]);
  const count = view?.chat.messages.length ?? 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [count, busy]);

  const messages = view?.chat.messages ?? [];
  const waiting = messages.at(-1)?.role === 'user';
  const answered = messages.some((m) => m.role === 'assistant');

  const send = async () => {
    const question = text.trim();
    if (!question || sending || busy) return;
    setSending(true);
    setError(null);
    try {
      const r = await api.askQuestion(projectId, subjectId, {
        chatId,
        context: { chapterUnitId, textbook: chapterUnitId === null },
        question,
        quote,
      });
      setText('');
      onClearQuote?.();
      setFresh(false);
      if (r.chatId === chatId) await load();
      else setChatId(r.chatId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const startNew = () => {
    setChatId(null);
    setView(null);
    setFresh(true);
  };

  const supplement = () => {
    if (!chatId || !chapterUnitId) return;
    setError(null);
    api.startSupplement(projectId, subjectId, chapterUnitId, chatId).catch((e) => setError(errorMessage(e)));
  };

  return (
    <aside className="chapter-chat" data-testid="tchat-panel" data-chat-id={chatId ?? ''}>
      <div className="row">
        <h2>{chapterUnitId ? 'この章について質問' : '教材について質問(科目全体)'}</h2>
        <span className="spacer" />
        {chatId && (
          <>
            <button className="small" data-testid="tchat-new" onClick={startNew}>
              新しい会話
            </button>
            <button className="small" data-testid="tchat-open" onClick={() => nav.go({ screen: 'chat', projectId, subjectId, chatId })}>
              広く表示
            </button>
          </>
        )}
      </div>
      <ErrorBox message={error} />
      {messages.length === 0 && (
        <div className="hint" data-testid="tchat-empty">
          {fresh ? '新しい会話を始めます。' : ''}
          {chapterUnitId
            ? '分からないところを書いてください。本文の文章を選ぶと「ここを質問」で、その箇所を引用して質問できます。Claude には、この章の本文・選んだ箇所・この単元の苦手マップ・目標を一緒に渡します。'
            : 'どの章から読むか、教材の進め方など、科目全体について質問できます。Claude には、目次と苦手マップを一緒に渡します。'}
        </div>
      )}
      <div data-testid="tchat-thread">
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`} data-testid="tchat-msg" data-role={m.role}>
            <div className="chat-who">{m.role === 'user' ? 'あなた' : 'Claude'}</div>
            {m.quote && <div className="chat-quote">{m.quote}</div>}
            {m.role === 'user' ? <div className="chat-text">{m.text}</div> : <Md text={m.text} />}
          </div>
        ))}
        {busy && (
          <div className="chat-msg assistant pending" data-testid="tchat-pending">
            <span className="spinner" /> Claude が答えを書いています…
          </div>
        )}
        {waiting && !busy && job && job.status !== 'done' && <JobRow job={job} onRetry={() => void api.retryJob(job.id).catch((e) => setError(errorMessage(e)))} />}
        <div ref={bottom} />
      </div>

      <div className="chat-input">
        {quote && (
          <div className="chat-quote" data-testid="tchat-quote">
            {quote}{' '}
            <button className="link" data-testid="tchat-quote-clear" onClick={onClearQuote}>
              引用をやめる
            </button>
          </div>
        )}
        <textarea
          ref={input}
          data-testid="tchat-input"
          value={text}
          rows={3}
          placeholder="質問を書く(数式は $x^2$ のように書けます)。Ctrl+Enter で送信"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
          }}
        />
        <button className="primary" data-testid="tchat-send" disabled={!text.trim() || sending || busy} onClick={() => void send()}>
          質問する
        </button>
      </div>

      {canSupplement && chapterUnitId && answered && (
        <div className="section" data-testid="tchat-supplement-box">
          <div className="hint">このやりとりで分かりにくかった所を、章の最後に「補足」として足せます(別の呼び出しで点検します。足す前の版は残ります)。</div>
          <button data-testid="tchat-supplement" disabled={supBusy || busy || waiting} onClick={supplement}>
            教材に反映
          </button>
          {supBusy && (
            <div className="toc-progress" data-testid="tchat-supplement-progress">
              <span className="spinner" /> {supJob?.status === 'queued' ? '順番を待っています' : supJob?.progress || '補足を書いています'}
            </div>
          )}
          {supJob && supJob.status === 'done' && (
            <div className="hint" data-testid="tchat-supplement-done">
              章に補足を足しました。
            </div>
          )}
          {supJob && (supJob.status === 'failed' || supJob.status === 'canceled') && <JobRow job={supJob} onRetry={() => void api.retryJob(supJob.id).catch((e) => setError(errorMessage(e)))} />}
        </div>
      )}
    </aside>
  );
}
