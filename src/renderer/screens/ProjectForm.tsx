import { useEffect, useState } from 'react';
import { daysLeftLabel, isValidDateString } from '../../shared/dates';
import { EXAM_TYPE_LABEL, TARGET_LEVEL_LABEL, type ExamType, type ProjectInput, type TargetLevel } from '../../shared/schema';
import { api, errorMessage } from '../api';
import { ErrorBox, Section } from '../components';
import { useNav } from '../nav';

const EMPTY: ProjectInput = {
  name: '',
  university: '',
  faculty: '',
  examDate: '',
  examType: 'kokkoritsu',
  targetLevel: 'solid',
  dailyMinutes: 180,
  subjectNames: [],
};

/** プロジェクトの作成と編集(同じ画面)。 */
export function ProjectForm({ projectId }: { projectId?: string }) {
  const nav = useNav();
  const [form, setForm] = useState<ProjectInput>(EMPTY);
  const [presets, setPresets] = useState<Array<{ name: string; group: string }>>([]);
  const [custom, setCustom] = useState('');
  const [today, setToday] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [nameTouched, setNameTouched] = useState(!!projectId);

  useEffect(() => {
    void (async () => {
      try {
        setPresets(await api.subjectPresets());
        setToday((await api.appInfo()).today);
        if (projectId) {
          const p = await api.getProject(projectId);
          setForm({
            name: p.name,
            university: p.university,
            faculty: p.faculty,
            examDate: p.examDate,
            examType: p.examType,
            targetLevel: p.targetLevel,
            dailyMinutes: p.dailyMinutes,
            subjectNames: p.subjects.map((s) => s.name),
          });
        }
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
  }, [projectId]);

  const set = <K extends keyof ProjectInput>(key: K, value: ProjectInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  const setUniversity = (university: string, faculty: string) => {
    setForm((f) => ({ ...f, university, faculty, name: nameTouched ? f.name : `${university} ${faculty}`.trim() }));
  };

  const toggleSubject = (name: string) => {
    setForm((f) => ({
      ...f,
      subjectNames: f.subjectNames.includes(name) ? f.subjectNames.filter((s) => s !== name) : [...f.subjectNames, name],
    }));
  };

  const addCustom = () => {
    const name = custom.trim();
    if (!name) return;
    if (!form.subjectNames.includes(name)) set('subjectNames', [...form.subjectNames, name]);
    setCustom('');
  };

  const problems: string[] = [];
  if (!form.name.trim()) problems.push('プロジェクト名を入れてください');
  if (!isValidDateString(form.examDate)) problems.push('試験日を入れてください');
  if (form.subjectNames.length === 0) problems.push('科目を1つ以上選んでください');

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const p = projectId ? await api.updateProject(projectId, form) : await api.createProject(form);
      nav.go({ screen: 'dashboard', projectId: p.id });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const groups = [...new Set(presets.map((p) => p.group))];
  const customSubjects = form.subjectNames.filter((n) => !presets.some((p) => p.name === n));

  return (
    <div className="page narrow" data-testid="screen-project-form">
      <Section title={projectId ? 'プロジェクトの設定を変える' : '新しいプロジェクト'}>
        <div className="form">
          <label>
            <span>大学名</span>
            <input data-testid="f-university" value={form.university} onChange={(e) => setUniversity(e.target.value, form.faculty)} placeholder="例: ○○大学" />
          </label>
          <label>
            <span>学部</span>
            <input data-testid="f-faculty" value={form.faculty} onChange={(e) => setUniversity(form.university, e.target.value)} placeholder="例: 理学部" />
          </label>
          <label>
            <span>プロジェクト名</span>
            <input
              data-testid="f-name"
              value={form.name}
              onChange={(e) => {
                setNameTouched(true);
                set('name', e.target.value);
              }}
              placeholder="例: ○○大学 理学部"
            />
          </label>
          <label>
            <span>試験日</span>
            <span>
              <input data-testid="f-examDate" type="date" value={form.examDate} onChange={(e) => set('examDate', e.target.value)} />
              {today && isValidDateString(form.examDate) && <span className="hint inline">{daysLeftLabel(today, form.examDate)}</span>}
            </span>
          </label>
          <label>
            <span>試験の型</span>
            <select data-testid="f-examType" value={form.examType} onChange={(e) => set('examType', e.target.value as ExamType)}>
              {(Object.keys(EXAM_TYPE_LABEL) as ExamType[]).map((k) => (
                <option key={k} value={k}>
                  {EXAM_TYPE_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>目標の高さ</span>
            <select data-testid="f-targetLevel" value={form.targetLevel} onChange={(e) => set('targetLevel', e.target.value as TargetLevel)}>
              {(Object.keys(TARGET_LEVEL_LABEL) as TargetLevel[]).map((k) => (
                <option key={k} value={k}>
                  {TARGET_LEVEL_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>1日に使える時間(分)</span>
            <input
              data-testid="f-dailyMinutes"
              type="number"
              min={10}
              max={960}
              step={10}
              value={form.dailyMinutes}
              onChange={(e) => set('dailyMinutes', Math.max(10, Math.min(960, Math.round(Number(e.target.value) || 0))))}
            />
          </label>
          <div className="form-row">
            <span>科目</span>
            <div className="subjects" data-testid="f-subjects">
              {groups.map((g) => (
                <div key={g} className="subject-group">
                  <span className="subject-group-name">{g}</span>
                  {presets
                    .filter((p) => p.group === g)
                    .map((p) => (
                      <label key={p.name} className="check">
                        <input type="checkbox" checked={form.subjectNames.includes(p.name)} onChange={() => toggleSubject(p.name)} data-testid={`subject-${p.name}`} />
                        {p.name}
                      </label>
                    ))}
                </div>
              ))}
              {customSubjects.length > 0 && (
                <div className="subject-group">
                  <span className="subject-group-name">その他</span>
                  {customSubjects.map((n) => (
                    <label key={n} className="check">
                      <input type="checkbox" checked onChange={() => toggleSubject(n)} />
                      {n}
                    </label>
                  ))}
                </div>
              )}
              <div className="subject-group">
                <input data-testid="f-custom-subject" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="一覧に無い科目名" />
                <button className="small" onClick={addCustom} data-testid="f-add-subject">
                  科目を足す
                </button>
              </div>
              {projectId && <div className="hint">科目を外しても、その科目のデータ(フォルダ)は消えません。</div>}
            </div>
          </div>
        </div>
        <ErrorBox message={error} />
        {problems.length > 0 && (
          <div className="hint" data-testid="form-problems">
            {problems.join(' / ')}
          </div>
        )}
        <div className="buttons">
          <button className="primary" data-testid="save-project" disabled={saving || problems.length > 0} onClick={() => void save()}>
            {projectId ? '保存する' : '作成する'}
          </button>
          <button onClick={() => nav.back()}>やめる</button>
        </div>
      </Section>
    </div>
  );
}
