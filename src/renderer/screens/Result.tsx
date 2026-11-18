import { useEffect, useState } from 'react';
import type { TakeView } from '../../core/answers';
import { api, errorMessage } from '../api';
import { ErrorBox, Section } from '../components';

/** 採点結果と解説の画面。 */
export function Result({ projectId, subjectId, testId }: { projectId: string; subjectId: string; testId: string }) {
  const [view, setView] = useState<TakeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.getTakeView(projectId, subjectId, testId).then(setView, (e) => setError(errorMessage(e)));
  }, [projectId, subjectId, testId]);
  if (!view) return <div className="page"><ErrorBox message={error} />{!error && '読み込み中…'}</div>;
  return (
    <div className="page" data-testid="screen-result">
      <Section title={view.test.title}>
        <div data-testid="result-submitted">答案を受け取りました。</div>
      </Section>
    </div>
  );
}
