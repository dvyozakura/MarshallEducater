import { Empty, Section } from '../components';

export function Plan({ projectId: _projectId }: { projectId: string }) {
  return (
    <div className="page" data-testid="screen-plan">
      <Section title="学習計画">
        <Empty>学習計画は、診断テストの採点が済んだあとに作れます。</Empty>
      </Section>
    </div>
  );
}
