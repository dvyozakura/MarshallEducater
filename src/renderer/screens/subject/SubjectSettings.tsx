import { useState } from 'react';
import { isKokugoSubject, subjectWritingMode, type WritingMode } from '../../../shared/notation';
import type { Project, SubjectRef } from '../../../shared/schema';
import { api, errorMessage } from '../../api';
import { ErrorBox, Md, TateFontControl } from '../../components';
import { NotationHelp } from '../NotationHelp';

/** 組み方向の見本(自作の文章。数字・英字・句読点・かっこ・長音・ダッシュ・ルビ・傍線・空欄を含む)。 */
export const WRITING_SAMPLE = [
  '{{段落:1}}朝の{駅|えき}は、いつもより静かだった。午前7時12分、ホームには3人しか立っていない。',
  '「もう、行ってしまったのかな――」と、私はつぶやいた。{{傍線:ア|時刻表の数字}}だけが、昨日と同じ顔をしている。',
  '{{段落:2}}発車ベルが鳴る。2026年のカレンダーには、まだ何も書いていない。ノートの表紙には「Science」とだけある。{{空欄:A}}に入る言葉を、私はまだ知らない!?',
].join('\n\n');

export function SubjectSettings({ project, subject, onChanged }: { project: Project; subject: SubjectRef; onChanged: (p: Project) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const mode = subjectWritingMode(subject);
  const change = async (m: WritingMode) => {
    setError(null);
    try {
      onChanged(await api.setSubjectWritingMode(project.id, subject.id, m));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div className="subject-settings" data-testid="subject-settings">
      <div className="row">
        <label>
          組み方向{' '}
          <select data-testid="writing-mode" value={mode} onChange={(e) => change(e.target.value as WritingMode)}>
            <option value="vertical">縦書き</option>
            <option value="horizontal">横書き</option>
          </select>
        </label>
        <span className="muted">{isKokugoSubject(subject.name) ? '国語系の科目は、既定で縦書きです。' : 'この科目は、既定で横書きです。'}</span>
        {mode === 'vertical' && <TateFontControl />}
      </div>
      <ErrorBox message={error} />
      <div className="muted" style={{ margin: '6px 0 4px' }}>
        見本(問題の本文・設問・教材の本文がこの向きで出ます。解説・所見・質問のやりとりは横書きのまま)
      </div>
      <Md text={WRITING_SAMPLE} vertical={mode === 'vertical'} testId="writing-sample" height="300px" />
      <button className="small" data-testid="notation-help-toggle" onClick={() => setHelp((v) => !v)} style={{ marginTop: 6 }}>
        {help ? '記法の一覧を閉じる' : '縦書きの記法の一覧と見本(ルビ・傍線・空欄・漢文など)'}
      </button>
      {help && <NotationHelp />}
    </div>
  );
}
