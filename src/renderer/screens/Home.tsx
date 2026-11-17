import { useEffect, useState } from 'react';
import { daysLeftLabel, formatDateJa } from '../../shared/dates';
import { EXAM_TYPE_LABEL, type Project } from '../../shared/schema';
import { api, errorMessage } from '../api';
import { Empty, ErrorBox, Section } from '../components';
import { useNav } from '../nav';

export function Home() {
  const nav = useNav();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [broken, setBroken] = useState<Array<{ folder: string; error: string }>>([]);
  const [today, setToday] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const info = await api.appInfo();
        setToday(info.today);
        const list = await api.listProjects();
        setProjects(list.projects);
        setBroken(list.broken);
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
  }, []);

  return (
    <div className="page" data-testid="screen-home">
      <Section
        title="プロジェクト"
        actions={
          <button className="primary" data-testid="new-project" onClick={() => nav.go({ screen: 'projectNew' })}>
            新しいプロジェクトを作る
          </button>
        }
      >
        <ErrorBox message={error} />
        {projects && projects.length === 0 && (
          <Empty>
            まだプロジェクトがありません。「新しいプロジェクトを作る」から、志望校と試験日を入れて始めましょう。
          </Empty>
        )}
        <div className="cards" data-testid="project-list">
          {(projects ?? []).map((p) => (
            <div key={p.id} className="card clickable" data-testid="project-card" onClick={() => nav.go({ screen: 'dashboard', projectId: p.id })}>
              <div className="card-title">{p.name}</div>
              <div className="card-sub">
                {p.university} {p.faculty}
              </div>
              <div className="card-line">
                {EXAM_TYPE_LABEL[p.examType]} ・ 試験日 {formatDateJa(p.examDate)}
              </div>
              <div className="card-line strong">{today ? daysLeftLabel(today, p.examDate) : ''}</div>
              <div className="card-line muted">科目: {p.subjects.map((s) => s.name).join('、')}</div>
            </div>
          ))}
        </div>
        {broken.length > 0 && (
          <div className="errorbox" data-testid="broken-projects">
            読めなかったフォルダがあります:
            <ul>
              {broken.map((b) => (
                <li key={b.folder}>
                  {b.folder} … {b.error}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>
    </div>
  );
}
