import { useEffect, useState } from 'react';
import type { Project } from '../../shared/schema';
import { api, errorMessage } from '../api';
import { ErrorBox } from '../components';
import { useNav } from '../nav';
import { ChatsTab } from './subject/ChatsTab';
import { NotesTab } from './subject/NotesTab';
import { SourcesTab } from './subject/SourcesTab';
import { TestsTab } from './subject/TestsTab';
import { TextbookTab } from './subject/TextbookTab';
import { TrendTab } from './subject/TrendTab';
import { UnitsTab } from './subject/UnitsTab';
import { WeaknessTab } from './subject/WeaknessTab';

export const SUBJECT_TABS = [
  { id: 'tests', label: 'テストと課題' },
  { id: 'textbook', label: '教材' },
  { id: 'sources', label: '資料' },
  { id: 'weakness', label: '苦手マップ' },
  { id: 'trend', label: '傾向' },
  { id: 'notes', label: '授業ノート' },
  { id: 'chats', label: '質問' },
  { id: 'units', label: '単元' },
] as const;
export type SubjectTabId = (typeof SUBJECT_TABS)[number]['id'];

export function Subject({ projectId, subjectId, tab }: { projectId: string; subjectId: string; tab?: string }) {
  const nav = useNav();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = (SUBJECT_TABS.find((t) => t.id === tab)?.id ?? 'tests') as SubjectTabId;

  useEffect(() => {
    api.getProject(projectId).then(setProject, (e) => setError(errorMessage(e)));
  }, [projectId]);

  const subject = project?.subjects.find((s) => s.id === subjectId);
  if (error) return <div className="page"><ErrorBox message={error} /></div>;
  if (!project) return <div className="page">読み込み中…</div>;
  if (!subject) return <div className="page"><ErrorBox message="この科目はプロジェクトにありません。" /></div>;

  const props = { projectId, subjectId };
  return (
    <div className="page" data-testid="screen-subject">
      <div className="row">
        <h1 data-testid="subject-name">{subject.name}</h1>
        <span className="muted">{project.name}</span>
      </div>
      <div className="tabs">
        {SUBJECT_TABS.map((t) => (
          <button key={t.id} className={t.id === current ? 'tab active' : 'tab'} data-testid={`tab-${t.id}`} onClick={() => nav.go({ screen: 'subject', projectId, subjectId, tab: t.id })}>
            {t.label}
          </button>
        ))}
      </div>
      <div data-testid={`tabpanel-${current}`}>
        {current === 'tests' && <TestsTab {...props} />}
        {current === 'textbook' && <TextbookTab {...props} />}
        {current === 'sources' && <SourcesTab {...props} />}
        {current === 'weakness' && <WeaknessTab {...props} />}
        {current === 'trend' && <TrendTab {...props} />}
        {current === 'notes' && <NotesTab {...props} />}
        {current === 'chats' && <ChatsTab {...props} />}
        {current === 'units' && <UnitsTab {...props} />}
      </div>
    </div>
  );
}
