import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatElapsed } from '../shared/dates';
import { failureGuide, failureTitle } from '../shared/failures';
import { JOB_STATUS_LABEL, type JobInfo } from '../shared/jobs';
import { api } from './api';
import { useNav } from './nav';

interface JobsState {
  jobs: JobInfo[];
  /** ジョブが終わるまで待つ(完了・失敗・取り消し)。 */
  waitFor: (jobId: string) => Promise<JobInfo>;
}

const JobsContext = createContext<JobsState>({ jobs: [], waitFor: () => new Promise(() => {}) });

const FINISHED = ['done', 'failed', 'canceled'];

export function JobsProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const waiters = useRef(new Map<string, Array<(j: JobInfo) => void>>());
  const latest = useRef<JobInfo[]>([]);
  latest.current = jobs;

  useEffect(() => {
    void api.listJobs().then(setJobs);
    return window.me.onEvent((ev) => {
      const e = ev as { type: string; job?: JobInfo };
      if (e.type === 'job' && e.job) {
        const job = e.job;
        setJobs((prev) => {
          const i = prev.findIndex((j) => j.id === job.id);
          if (i < 0) return [...prev, job];
          const next = prev.slice();
          next[i] = job;
          return next;
        });
        if (FINISHED.includes(job.status)) {
          for (const w of waiters.current.get(job.id) ?? []) w(job);
          waiters.current.delete(job.id);
        }
      }
      if (e.type === 'jobs-cleared') void api.listJobs().then(setJobs);
    });
  }, []);

  const waitFor = useCallback((jobId: string) => {
    return new Promise<JobInfo>((resolve) => {
      const done = latest.current.find((j) => j.id === jobId && FINISHED.includes(j.status));
      if (done) return resolve(done);
      const list = waiters.current.get(jobId) ?? [];
      list.push(resolve);
      waiters.current.set(jobId, list);
      // 知らせを取りこぼした場合に備えて、いまの状態も確かめる
      void api.listJobs().then((all) => {
        const j = all.find((x) => x.id === jobId);
        if (j && FINISHED.includes(j.status)) {
          for (const w of waiters.current.get(jobId) ?? []) w(j);
          waiters.current.delete(jobId);
        }
      });
    });
  }, []);

  return <JobsContext.Provider value={{ jobs, waitFor }}>{children}</JobsContext.Provider>;
}

export function useJobs(): JobsState {
  return useContext(JobsContext);
}

/** 1秒ごとに描き直す(経過時間の表示用)。 */
function useTick(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function jobElapsed(job: JobInfo, now: number): string {
  if (!job.startedAt) return '';
  const end = job.endedAt ? Date.parse(job.endedAt) : now;
  return formatElapsed(end - Date.parse(job.startedAt));
}

/** どの画面にも出る、ジョブの状態の帯。 */
export function JobBar() {
  const { jobs } = useJobs();
  const nav = useNav();
  const running = jobs.filter((j) => j.status === 'running');
  const queued = jobs.filter((j) => j.status === 'queued');
  const failed = jobs.filter((j) => j.status === 'failed');
  const done = jobs.filter((j) => j.status === 'done');
  const now = useTick(running.length > 0);
  const projectId = 'projectId' in nav.route ? nav.route.projectId : undefined;
  return (
    <div className="jobbar" data-testid="jobbar" onClick={() => nav.go({ screen: 'jobs', projectId })} title="クリックでジョブ一覧を開く">
      <span className="jobbar-counts">
        <span className={running.length ? 'badge running' : 'badge'} data-testid="jobbar-running">
          実行中 {running.length}
        </span>
        <span className="badge" data-testid="jobbar-queued">
          待ち {queued.length}
        </span>
        <span className="badge" data-testid="jobbar-done">
          完了 {done.length}
        </span>
        <span className={failed.length ? 'badge failed' : 'badge'} data-testid="jobbar-failed">
          失敗 {failed.length}
        </span>
      </span>
      <span className="jobbar-current">
        {running.length > 0
          ? running.map((j) => (
              <span key={j.id} className="jobbar-item">
                <span className="spinner" /> {j.title}
                {j.progress ? `(${j.progress})` : ''} {jobElapsed(j, now)}
              </span>
            ))
          : 'Claude は待機中です'}
      </span>
    </div>
  );
}

/** ジョブ1件の表示(一覧・各画面の待ち表示で共通)。 */
export function JobRow({ job, onRetry }: { job: JobInfo; onRetry?: () => void }) {
  const now = useTick(job.status === 'running');
  return (
    <div className={`jobrow status-${job.status}`} data-testid="jobrow" data-status={job.status} data-kind={job.kind}>
      <div className="jobrow-main">
        <span className={`badge ${job.status}`}>{JOB_STATUS_LABEL[job.status]}</span>
        <span className="jobrow-title">{job.title}</span>
        {job.progress && job.status === 'running' && <span className="jobrow-progress">{job.progress}</span>}
        <span className="jobrow-time">{job.startedAt ? `経過 ${jobElapsed(job, now)}` : ''}</span>
        {(job.status === 'running' || job.status === 'queued') && (
          <button className="small" onClick={() => void api.cancelJob(job.id)} data-testid="job-cancel">
            取り消す
          </button>
        )}
        {job.status === 'failed' && onRetry && (
          <button className="small" onClick={onRetry} data-testid="job-retry">
            もう一度試す
          </button>
        )}
      </div>
      {job.status === 'failed' && job.error && (
        <div className="failure" data-testid="job-failure" data-failure={job.error.kind}>
          <div className="failure-title">{failureTitle(job.error.kind)}</div>
          <div className="failure-guide">{failureGuide(job.error.kind)}</div>
          {job.error.message && <pre className="failure-detail">{job.error.message}</pre>}
        </div>
      )}
    </div>
  );
}

/**
 * ジョブを始めて、終わるまでの様子を持つ。画面ごとの「〜を作る」ボタンで使う。
 * 待っている間も他の画面に移れる(ジョブ自体は main 側で動き続ける)。
 */
export function useJobRunner(onDone?: (job: JobInfo) => void) {
  const { jobs, waitFor } = useJobs();
  const [jobId, setJobId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const job = jobs.find((j) => j.id === jobId) ?? null;
  const start = useCallback(
    async (starter: () => Promise<JobInfo>) => {
      setStartError(null);
      try {
        const j = await starter();
        setJobId(j.id);
        const finished = await waitFor(j.id);
        if (finished.status === 'done') onDoneRef.current?.(finished);
        return finished;
      } catch (e) {
        setStartError(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [waitFor],
  );
  const busy = !!job && (job.status === 'queued' || job.status === 'running');
  return { job, busy, start, startError };
}
