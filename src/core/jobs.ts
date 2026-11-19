import { EventEmitter } from 'node:events';
import type { FailureInfo } from '../shared/failures';
import type { JobInfo } from '../shared/jobs';
import { ClaudeError } from './claude/task';

export interface JobContext {
  signal: AbortSignal;
  /** いま何をしているかを画面に知らせる。 */
  progress: (text: string) => void;
}

export interface JobSpec {
  kind: string;
  title: string;
  projectId?: string | null;
  params?: unknown;
  run: (ctx: JobContext) => Promise<unknown>;
}

interface Entry {
  info: JobInfo;
  spec: JobSpec;
  abort: AbortController;
  waiters: Array<(info: JobInfo) => void>;
}

function toFailure(e: unknown, canceled: boolean): FailureInfo {
  if (canceled) return { kind: 'canceled', message: '取り消しました' };
  if (e instanceof ClaudeError) return { kind: e.kind, message: e.detail, ...(e.engine !== 'claude' ? { engine: e.engine } : {}) };
  return { kind: 'other', message: e instanceof Error ? e.message : String(e) };
}

/**
 * ジョブの列。同時実行数までを動かし、残りは待たせる。
 * 'change' イベントで、変わったジョブの情報(JobInfo)を知らせる。
 */
export class JobQueue extends EventEmitter {
  private entries: Entry[] = [];
  private seq = 0;

  constructor(private readonly getConcurrency: () => number = () => 2) {
    super();
  }

  add(spec: JobSpec): JobInfo {
    const info: JobInfo = {
      id: `job-${Date.now().toString(36)}-${++this.seq}`,
      kind: spec.kind,
      title: spec.title,
      projectId: spec.projectId ?? null,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      progress: '',
      error: null,
      params: spec.params ?? null,
      result: null,
    };
    this.entries.push({ info, spec, abort: new AbortController(), waiters: [] });
    this.emitChange(info);
    queueMicrotask(() => this.pump());
    return { ...info };
  }

  list(): JobInfo[] {
    return this.entries.map((e) => ({ ...e.info }));
  }

  get(id: string): JobInfo | null {
    const e = this.entries.find((x) => x.info.id === id);
    return e ? { ...e.info } : null;
  }

  /** 待ちなら列から外し、実行中なら止める。 */
  cancel(id: string): boolean {
    const e = this.entries.find((x) => x.info.id === id);
    if (!e) return false;
    if (e.info.status === 'queued') {
      e.abort.abort();
      this.finish(e, 'canceled', { kind: 'canceled', message: '取り消しました' }, null);
      return true;
    }
    if (e.info.status === 'running') {
      e.abort.abort();
      return true;
    }
    return false;
  }

  /** ジョブが終わる(完了・失敗・取り消し)まで待つ。 */
  wait(id: string): Promise<JobInfo> {
    const e = this.entries.find((x) => x.info.id === id);
    if (!e) return Promise.reject(new Error(`ジョブ ${id} がありません`));
    if (['done', 'failed', 'canceled'].includes(e.info.status)) return Promise.resolve({ ...e.info });
    return new Promise((resolve) => e.waiters.push(resolve));
  }

  /** 終わったジョブを一覧から消す。 */
  clearFinished(): void {
    this.entries = this.entries.filter((e) => e.info.status === 'queued' || e.info.status === 'running');
    this.emit('cleared');
  }

  runningCount(): number {
    return this.entries.filter((e) => e.info.status === 'running').length;
  }

  private emitChange(info: JobInfo): void {
    this.emit('change', { ...info });
  }

  private finish(e: Entry, status: 'done' | 'failed' | 'canceled', error: FailureInfo | null, result: unknown): void {
    e.info.status = status;
    e.info.endedAt = new Date().toISOString();
    e.info.error = error;
    e.info.result = result ?? null;
    this.emitChange(e.info);
    for (const w of e.waiters.splice(0)) w({ ...e.info });
  }

  /** 同時実行数に空きがあれば、待ちの先頭から動かす。設定が変わったときにも呼ぶ。 */
  pump(): void {
    const limit = Math.max(1, Math.floor(this.getConcurrency()));
    while (this.runningCount() < limit) {
      const next = this.entries.find((e) => e.info.status === 'queued');
      if (!next) return;
      this.start(next);
    }
  }

  private start(e: Entry): void {
    e.info.status = 'running';
    e.info.startedAt = new Date().toISOString();
    this.emitChange(e.info);
    const ctx: JobContext = {
      signal: e.abort.signal,
      progress: (text) => {
        if (e.info.status !== 'running') return;
        e.info.progress = text;
        this.emitChange(e.info);
      },
    };
    Promise.resolve()
      .then(() => e.spec.run(ctx))
      .then(
        (result) => {
          if (e.abort.signal.aborted) this.finish(e, 'canceled', { kind: 'canceled', message: '取り消しました' }, null);
          else this.finish(e, 'done', null, result);
        },
        (err) => {
          const f = toFailure(err, e.abort.signal.aborted);
          this.finish(e, f.kind === 'canceled' ? 'canceled' : 'failed', f, null);
        },
      )
      .finally(() => this.pump());
  }
}
