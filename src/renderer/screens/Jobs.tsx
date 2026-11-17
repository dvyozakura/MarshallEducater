import { api } from '../api';
import { Empty, Section } from '../components';
import { JobRow, useJobs } from '../jobs';

/** ジョブ一覧: 実行中・待ち・完了・失敗と経過時間。取り消しと再試行ができる。 */
export function Jobs() {
  const { jobs } = useJobs();
  const ordered = [...jobs].reverse();
  const active = ordered.filter((j) => j.status === 'running' || j.status === 'queued');
  const finished = ordered.filter((j) => j.status !== 'running' && j.status !== 'queued');
  return (
    <div className="page" data-testid="screen-jobs">
      <Section title="実行中・待ち">
        {active.length === 0 && <Empty>いま動いているジョブはありません。</Empty>}
        {active.map((j) => (
          <JobRow key={j.id} job={j} />
        ))}
        <div className="hint">Claude の呼び出しは1回に数分かかることがあります。待っている間も、ほかの画面を使えます。</div>
      </Section>
      <Section
        title="終わったもの"
        actions={
          <button className="small" data-testid="clear-jobs" disabled={finished.length === 0} onClick={() => void api.clearFinishedJobs()}>
            一覧から消す
          </button>
        }
      >
        {finished.length === 0 && <Empty>まだありません。</Empty>}
        {finished.map((j) => (
          <JobRow key={j.id} job={j} onRetry={() => void api.retryJob(j.id)} />
        ))}
      </Section>
    </div>
  );
}
