import { useEffect, useState } from 'react';
import { TEST_KIND_LABEL, TEST_STATUS_LABEL, type Test } from '../../../shared/schema';
import { api, errorMessage } from '../../api';
import { Empty, ErrorBox } from '../../components';
import { JobRow, useJobRunner, useJobs } from '../../jobs';
import { useNav } from '../../nav';

/** 問題冊子・解答用紙を PDF に出すボタンと、保存先の表示。 */
export function PdfButtons({ projectId, subjectId, testId }: { projectId: string; subjectId: string; testId: string }) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (which: 'booklet' | 'answer_sheet') => {
    setBusy(true);
    setError(null);
    try {
      setSaved((await api.exportTestPdf(projectId, subjectId, testId, which)).path);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="small" data-testid="export-booklet" disabled={busy} onClick={() => void run('booklet')}>
        問題冊子を PDF に
      </button>
      <button className="small" data-testid="export-sheet" disabled={busy} onClick={() => void run('answer_sheet')}>
        解答用紙を PDF に
      </button>
      {saved && (
        <span className="hint" data-testid="export-path">
          保存しました: {saved}{' '}
          <button className="link" onClick={() => void api.revealFile(saved)}>
            フォルダで表示
          </button>
        </span>
      )}
      {error && <span className="errorbox">{error}</span>}
    </>
  );
}

/** テスト1件の行(科目の画面・ダッシュボードで共通)。 */
export function TestRow({ projectId, test }: { projectId: string; test: Test }) {
  const nav = useNav();
  const subjectId = test.subjectId;
  const total = test.problems.reduce((n, p) => n + p.points, 0);
  const at = { projectId, subjectId, testId: test.id };
  return (
    <div className="list-item" data-testid="test-row" data-kind={test.kind} data-status={test.status} data-test-id={test.id}>
      <span className="badge">{TEST_KIND_LABEL[test.kind]}</span>
      <span className="grow">
        <strong>{test.title}</strong>{' '}
        <span className="muted">
          {test.problems.length} 問・{total} 点・{test.timeLimitMin} 分{test.date ? `・${test.date}` : ''}
        </span>
      </span>
      <span className={`badge ${test.status === 'graded' ? 'good' : test.status === 'ready' ? '' : 'mid'}`} data-testid="test-status">
        {TEST_STATUS_LABEL[test.status]}
      </span>
      {test.status === 'ready' && (
        <>
          <button className="small primary" data-testid="take-test" onClick={() => nav.go({ screen: 'take', ...at })}>
            アプリで解く
          </button>
          <button className="small" data-testid="submit-paper" onClick={() => nav.go({ screen: 'import', ...at })}>
            紙の答案を出す
          </button>
        </>
      )}
      {test.status === 'reading' && (
        <button className="small primary" data-testid="open-submission" onClick={() => nav.go({ screen: 'correction', projectId, subjectId, sourceId: `sub-${test.id}` })}>
          答案の読み取りを確かめる
        </button>
      )}
      {(test.status === 'submitted' || test.status === 'graded') && (
        <button className="small primary" data-testid="open-result" onClick={() => nav.go({ screen: 'result', ...at })}>
          {test.status === 'graded' ? '結果と解説' : '採点へ'}
        </button>
      )}
      <PdfButtons {...at} />
    </div>
  );
}

/** 科目の「テストと課題」: 一覧と、実力診断テストの作成。 */
export function TestsTab({ projectId, subjectId }: { projectId: string; subjectId: string }) {
  const [tests, setTests] = useState<Test[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { jobs } = useJobs();
  const load = () => api.listTests(projectId, subjectId).then(setTests, (e) => setError(errorMessage(e)));
  // ほかの画面で始めたジョブが終わったときも、一覧を読み直す
  const finished = jobs.filter((j) => j.projectId === projectId && j.status === 'done').length;
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, subjectId, finished]);

  const creator = useJobRunner(() => void load());
  const create = () => void creator.start(() => api.startCreateDiagnostic(projectId, subjectId));
  const hasDiagnostic = (tests ?? []).some((t) => t.kind === 'diagnostic');

  return (
    <div data-testid="tests-tab">
      <div className="row">
        <button className={hasDiagnostic ? '' : 'primary'} data-testid="create-diagnostic" disabled={creator.busy} onClick={create}>
          {hasDiagnostic ? '実力診断テストをもう一度作る' : '実力診断テストを作る'}
        </button>
        <span className="hint">Claude が単元を広く覆うテストを作り、別の呼び出しで解き直して確かめます(数分かかります)。</span>
      </div>
      {creator.job && creator.job.status !== 'done' && <JobRow job={creator.job} onRetry={create} />}
      <ErrorBox message={error ?? creator.startError} />
      {tests && tests.length === 0 && <Empty>まだテストがありません。最初に実力診断テストを作って、いまの位置を確かめましょう。</Empty>}
      {(tests ?? []).map((t) => (
        <TestRow key={t.id} projectId={projectId} test={t} />
      ))}
    </div>
  );
}
