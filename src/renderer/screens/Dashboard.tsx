import { useEffect, useState } from 'react';
import { daysLeftLabel, formatDateJa } from '../../shared/dates';
import { EXAM_TYPE_LABEL, TARGET_LEVEL_LABEL, type Project } from '../../shared/schema';
import { api, errorMessage } from '../api';
import { ErrorBox, Section } from '../components';
import { useNav } from '../nav';

export function Dashboard({ projectId }: { projectId: string }) {
  const nav = useNav();
  const [project, setProject] = useState<Project | null>(null);
  const [today, setToday] = useState('');
  const [error, setError] = useState<string | null>(null);

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

      <Section title="科目" testId="subjects-section">
        <div className="cards">
          {project.subjects.map((s) => (
            <div key={s.id} className="card clickable" data-testid="subject-card" onClick={() => nav.go({ screen: 'subject', projectId, subjectId: s.id })}>
              <div className="card-title">{s.name}</div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
