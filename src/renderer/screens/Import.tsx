import { Empty, Section } from '../components';

export function Import({ projectId: _projectId }: { projectId: string; subjectId?: string; testId?: string }) {
  return (
    <div className="page" data-testid="screen-import">
      <Section title="資料の取り込み">
        <Empty>PDF や画像の取り込みは、ここから行います。</Empty>
      </Section>
    </div>
  );
}
