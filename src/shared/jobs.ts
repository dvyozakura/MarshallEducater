import type { FailureInfo } from './failures';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: '待ち',
  running: '実行中',
  done: '完了',
  failed: '失敗',
  canceled: '取り消し',
};

/** 画面に見せるジョブの情報。 */
export interface JobInfo {
  id: string;
  /** 種類(例: generate_test)。再試行のときにも使う。 */
  kind: string;
  /** 画面に出す名前(例: 「数学 診断テストの作成」)。 */
  title: string;
  projectId: string | null;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** いま何をしているか(例: 「検算中 2/5」)。 */
  progress: string;
  error: FailureInfo | null;
  /** 再試行に使う引数。 */
  params: unknown;
  /** 終わったあとの結果(小さいものだけ)。 */
  result: unknown;
}
