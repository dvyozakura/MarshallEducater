import { useEffect, useState } from 'react';
import type { AppSettings } from '../../shared/schema';
import { api, errorMessage } from '../api';
import { ErrorBox, Md, Section } from '../components';
import { JobRow, useJobRunner } from '../jobs';
import { ENGINE_SHORT } from '../../shared/engines';
import { EngineSettingsSection } from './EngineSettings';

type Info = Awaited<ReturnType<typeof api.appInfo>>;

export function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [usage, setUsage] = useState<{ used: number; limit: number } | null>(null);
  const [quality, setQuality] = useState<Awaited<ReturnType<typeof api.getQuality>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [mathSample, setMathSample] = useState('2次方程式 $ax^2+bx+c=0$ の解は\n\n$$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$');

  const load = async () => {
    try {
      setSettings(await api.getSettings());
      setInfo(await api.appInfo());
      setUsage(await api.usage());
      setQuality(await api.getQuality());
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const ping = useJobRunner(() => void api.usage().then(setUsage));

  if (!settings || !info) return <div className="page"><ErrorBox message={error} /></div>;

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings({ ...settings, [key]: value });
    setSaved(false);
  };
  const num = (v: string, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v) || min)));

  const save = async () => {
    setError(null);
    try {
      setSettings(await api.updateSettings(settings));
      setInfo(await api.appInfo());
      setUsage(await api.usage());
      setSaved(true);
      setSavedCount((n) => n + 1);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="page narrow" data-testid="screen-settings">
      <Section title="設定">
        {info.settingsProblem && <div className="notice">設定ファイルを読めなかったため、既定の設定で動いています。{info.settingsProblem}</div>}
        {info.fakeClaude && <div className="notice" data-testid="fake-notice">いまは偽 Claude(テスト用)で動いています。</div>}
        <div className="form">
          <label>
            <span>claude の場所</span>
            <input data-testid="s-claudePath" value={settings.claudePath} onChange={(e) => set('claudePath', e.target.value)} placeholder="空なら自動で探します(PATH の claude)" />
          </label>
          <label>
            <span>モデル</span>
            <span>
              <input data-testid="s-model" list="models" value={settings.model} onChange={(e) => set('model', e.target.value)} placeholder="空なら Claude Code の既定" />
              <datalist id="models">
                <option value="sonnet" />
                <option value="opus" />
                <option value="haiku" />
                <option value="fable" />
              </datalist>
              <span className="hint inline">別名(sonnet / opus / haiku など)か、正式なモデル名</span>
            </span>
          </label>
          <label>
            <span>同時に動かす数</span>
            <input data-testid="s-concurrency" type="number" min={1} max={8} value={settings.concurrency} onChange={(e) => set('concurrency', num(e.target.value, 1, 8))} />
          </label>
          <label>
            <span>1日の上限(回)</span>
            <span>
              <input data-testid="s-dailyLimit" type="number" min={1} value={settings.dailyLimit} onChange={(e) => set('dailyLimit', num(e.target.value, 1, 100000))} />
              {usage && (
                <span className="hint inline" data-testid="usage">
                  今日は {usage.used} 回呼び出しました(上限 {usage.limit} 回)
                </span>
              )}
            </span>
          </label>
          <label>
            <span>1回の制限時間(分)</span>
            <input data-testid="s-timeoutMin" type="number" min={1} max={180} value={settings.timeoutMin} onChange={(e) => set('timeoutMin', num(e.target.value, 1, 180))} />
          </label>
          <label>
            <span>データの場所</span>
            <span>
              <input data-testid="s-dataDir" value={settings.dataDir} disabled={info.dataDirLocked} onChange={(e) => set('dataDir', e.target.value)} placeholder={info.defaultDataDir} style={{ width: 360 }} />
              <div className="hint" data-testid="data-dir">
                いま使っている場所: {info.dataDir}
                {info.dataDirLocked ? '(環境変数 ME_DATA_DIR で固定されています)' : ''}
              </div>
            </span>
          </label>
        </div>
        <ErrorBox message={error} />
        <div className="buttons">
          <button className="primary" data-testid="save-settings" onClick={() => void save()}>
            保存する
          </button>
          {saved && <span className="hint" data-testid="settings-saved">保存しました</span>}
        </div>
      </Section>

      <EngineSettingsSection settings={settings} set={set} savedCount={savedCount} />
      <div className="buttons">
        <button className="primary" data-testid="save-settings-engines" onClick={() => void save()}>
          教員エンジンの設定を保存する
        </button>
        {saved && <span className="hint">保存しました</span>}
      </div>

      <Section title="Claude との接続">
        <div className="row">
          <button data-testid="ping" disabled={ping.busy} onClick={() => void ping.start(() => api.startPing())}>
            接続を確認する
          </button>
          <span className="hint">Claude Code を1回だけ呼び出して、返事が来るかを確かめます。</span>
        </div>
        {ping.job && <JobRow job={ping.job} onRetry={() => void ping.start(() => api.startPing())} />}
        {ping.job?.status === 'done' && (
          <div className="info" data-testid="ping-ok">
            接続できました。
          </div>
        )}
        <ErrorBox message={ping.startError} />
      </Section>

      <Section title="品質" testId="quality">
        <div className="hint">Claude の仕事の確かさの目安です(すべてのプロジェクトの合計)。</div>
        {quality && (
          <table className="grid">
            <tbody>
              <tr data-testid="q-verify">
                <th>問題の検算</th>
                <td>
                  {quality.verify.total === 0 ? (
                    'まだ問題を作っていません。'
                  ) : (
                    <>
                      採用 <strong>{quality.verify.adopted}</strong> ・ 作り直して採用 <strong>{quality.verify.regenerated}</strong> ・ 破棄 <strong>{quality.verify.discarded}</strong>{' '}
                      <span className="muted">
                        (テスト {quality.verify.tests} 件。1回で通った割合 {quality.verify.adoptedRate}%)
                      </span>
                    </>
                  )}
                  <div className="hint">作った問題は、別の呼び出しで解答を見せずに解き直し、答えが一致したものだけを使っています。</div>
                </td>
              </tr>
              <tr data-testid="q-problems">
                <th>問題の読み取り</th>
                <td>
                  {quality.problems.rate === null ? (
                    'まだ補正の記録がありません。'
                  ) : (
                    <>
                      補正率 <strong>{quality.problems.rate}%</strong>{' '}
                      <span className="muted">
                        (資料 {quality.problems.sources} 件、読み取った {quality.problems.originalChars} 字のうち {quality.problems.changedChars} 字を修正、操作 {quality.problems.edits} 回)
                      </span>
                    </>
                  )}
                </td>
              </tr>
              <tr data-testid="q-answers">
                <th>答案の読み取り</th>
                <td>
                  {quality.answers.rate === null ? (
                    'まだ補正の記録がありません。'
                  ) : (
                    <>
                      補正率 <strong>{quality.answers.rate}%</strong>{' '}
                      <span className="muted">
                        (答案 {quality.answers.sources} 件、読み取った {quality.answers.originalChars} 字のうち {quality.answers.changedChars} 字を修正、操作 {quality.answers.edits} 回)
                      </span>
                    </>
                  )}
                  <div className="hint">補正率が低いほど、Claude の読み取りがそのまま使えています。</div>
                </td>
              </tr>
              <tr data-testid="q-textbook">
                <th>教材の点検</th>
                <td>
                  {quality.textbook.reviews === 0 ? (
                    'まだ教材の章を作っていません。'
                  ) : (
                    <>
                      点検 <strong>{quality.textbook.reviews}</strong> 回のうち、指摘あり <strong>{quality.textbook.withIssues}</strong> 回(指摘 <strong>{quality.textbook.issues}</strong> 件、直した回数{' '}
                      <strong>{quality.textbook.revised}</strong>){' '}
                      <span className="muted">(点検の記録がある章 {quality.textbook.chapters} 章)</span>
                    </>
                  )}
                  <div className="hint">教材の本文は、別の呼び出しで事実・計算・用語を点検し、指摘があれば1回直してから完成にしています。例題・確認問題の検算は、上の「問題の検算」に含まれます。</div>
                </td>
              </tr>
              <tr data-testid="q-grading">
                <th>採点の上書き</th>
                <td>
                  {quality.grading.items === 0 ? (
                    'まだ採点がありません。'
                  ) : (
                    <>
                      <strong>{quality.grading.overridden}</strong> / {quality.grading.items} 問({quality.grading.rate}%){' '}
                      <span className="muted">(採点したテスト {quality.grading.tests} 件)</span>
                    </>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        )}
        {quality && quality.byEngine.length > 0 && (
          <>
            <div className="hint">作ったエンジン別(問題・読み取り・採点・教材を作ったエンジンで分けています。記録の無い前の版のものは Claude として数えます):</div>
            <table className="grid" data-testid="q-by-engine">
              <thead>
                <tr>
                  <th>エンジン</th>
                  <th>検算(1回で通った割合)</th>
                  <th>問題の読み取り(補正率)</th>
                  <th>答案の読み取り(補正率)</th>
                  <th>教材の点検(指摘あり)</th>
                  <th>採点の上書き</th>
                </tr>
              </thead>
              <tbody>
                {quality.byEngine.map(({ engine, quality: q }) => (
                  <tr key={engine} data-testid={`q-engine-${engine}`}>
                    <th>{ENGINE_SHORT[engine]}</th>
                    <td>{q.verify.total === 0 ? '—' : `${q.verify.adoptedRate}%(${q.verify.adopted}/${q.verify.total})`}</td>
                    <td>{q.problems.rate === null ? '—' : `${q.problems.rate}%`}</td>
                    <td>{q.answers.rate === null ? '—' : `${q.answers.rate}%`}</td>
                    <td>{q.textbook.reviews === 0 ? '—' : `${q.textbook.withIssues} / ${q.textbook.reviews} 回`}</td>
                    <td>{q.grading.items === 0 ? '—' : `${q.grading.overridden} / ${q.grading.items} 問`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Section>

      <Section title="数式の表示の確認">
        <div className="hint">数式は LaTeX で書きます。文中は $...$、独立した式は $$...$$ です。下で試せます。</div>
        <div className="split">
          <textarea data-testid="math-input" rows={4} value={mathSample} onChange={(e) => setMathSample(e.target.value)} />
          <Md text={mathSample} testId="math-preview" className="preview" />
        </div>
      </Section>
    </div>
  );
}
