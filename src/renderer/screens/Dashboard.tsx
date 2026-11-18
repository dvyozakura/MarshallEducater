import { useEffect, useState } from 'react';
import { daysLeftLabel, formatDateJa } from '../../shared/dates';
import { EXAM_TYPE_LABEL, TARGET_LEVEL_LABEL, TEST_STATUS_LABEL, type Project, type Test } from '../../shared/schema';
import { api, errorMessage } from '../api';
import { ErrorBox, Section } from '../components';
import { JobRow, useJobs } from '../jobs';
import { TestRow } from './subject/TestsTab';
import { useNav } from '../nav';

export function Dashboard({ projectId }: { projectId: string }) {
  const nav = useNav();
  const [project, setProject] = useState<Project | null>(null);
  const [today, setToday] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { jobs } = useJobs();
  const activeJobs = jobs.filter((j) => j.projectId === projectId && (j.status === 'running' || j.status === 'queued'));
  const [tests, setTests] = useState<Record<string, Test[]>>({});
  const finished = jobs.filter((j) => j.projectId === projectId && j.status !== 'running' && j.status !== 'queued').length;
  useEffect(() => {
    if (!project) return;
    void Promise.all(project.subjects.map(async (s) => [s.id, await api.listTests(projectId, s.id)] as const)).then(
      (pairs) => setTests(Object.fromEntries(pairs)),
      (e) => setError(errorMessage(e)),
    );
  }, [project, projectId, finished]);
  const creating = (subjectId: string) => activeJobs.some((j) => j.kind === 'create_diagnostic' && (j.params as { subjectId?: string } | null)?.subjectId === subjectId);
  const diagnosticOf = (subjectId: string) => (tests[subjectId] ?? []).find((t) => t.kind === 'diagnostic') ?? null;
  const createDiagnostic = (subjectId: string) => void api.startCreateDiagnostic(projectId, subjectId).catch((e) => setError(errorMessage(e)));

  useEffect(() => {
    void (async () => {
      try {
        setToday((await api.appInfo()).today);
        setProject(await api.getProject(projectId));
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
  }, [projectId]);

  if (error) return <div className="page"><ErrorBox message={error} /></div>;
  if (!project) return <div className="page">読み込み中…</div>;

  const noDiagnostic = project.subjects.filter((s) => tests[s.id] && !diagnosticOf(s.id));
  const openTests = project.subjects.flatMap((s) => (tests[s.id] ?? []).filter((t) => t.status !== 'graded' && t.kind !== 'daily'));

  return (
    <div className="page" data-testid="screen-dashboard">
      <div className="hero">
        <div>
          <h1 data-testid="project-name">{project.name}</h1>
          <div className="muted" data-testid="project-summary">
            {project.university} {project.faculty} ・ {EXAM_TYPE_LABEL[project.examType]} ・ {TARGET_LEVEL_LABEL[project.targetLevel]} ・ 1日 {project.dailyMinutes} 分
          </div>
        </div>
        <div className="hero-right">
          <div className="countdown" data-testid="days-left">
            {today ? daysLeftLabel(today, project.examDate) : ''}
          </div>
          <div className="muted">試験日 {formatDateJa(project.examDate)}</div>
          <button className="small" data-testid="edit-project" onClick={() => nav.go({ screen: 'projectEdit', projectId })}>
            設定を変える
          </button>
        </div>
      </div>

      {activeJobs.length > 0 && (
        <Section title="実行中のジョブ" testId="dashboard-jobs">
          {activeJobs.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </Section>
      )}

      {noDiagnostic.length > 0 && (
        <div className="notice" data-testid="diag-guide">
          <strong>まず、科目ごとに実力診断テストを作りましょう。</strong> Claude が「いまの位置」と「苦手の当たり」を調べるテストを作ります(過去問の取り込みがまだでも作れます)。まだの科目: {noDiagnostic.map((s) => s.name).join('、')}
          <div className="buttons">
            <button className="primary" data-testid="diag-create-all" disabled={noDiagnostic.every((s) => creating(s.id))} onClick={() => noDiagnostic.filter((s) => !creating(s.id)).forEach((s) => createDiagnostic(s.id))}>
              まだの科目すべてで作る
            </button>
          </div>
        </div>
      )}

      <Section title="科目" testId="subjects-section">
        <div className="cards">
          {project.subjects.map((s) => {
            const d = diagnosticOf(s.id);
            return (
              <div key={s.id} className="card clickable" data-testid="subject-card" data-subject={s.name} onClick={() => nav.go({ screen: 'subject', projectId, subjectId: s.id })}>
                <div className="card-title">{s.name}</div>
                <div className="card-line" data-testid="subject-diag">
                  {creating(s.id) ? (
                    <span>
                      <span className="spinner" /> 診断テストを作っています
                    </span>
                  ) : d ? (
                    <span className="muted">診断テスト: {TEST_STATUS_LABEL[d.status]}</span>
                  ) : tests[s.id] ? (
                    <button
                      className="small"
                      data-testid="diag-create"
                      onClick={(e) => {
                        e.stopPropagation();
                        createDiagnostic(s.id);
                      }}
                    >
                      実力診断テストを作る
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      {openTests.length > 0 && (
        <Section title="これから解くテスト・採点待ち" testId="open-tests">
          {openTests.map((t) => (
            <TestRow key={t.id} projectId={projectId} test={t} />
          ))}
        </Section>
      )}
    </div>
  );
}
