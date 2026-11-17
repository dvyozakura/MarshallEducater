import { useEffect, useState } from 'react';
import type { AppSettings } from '../../shared/schema';
import { api, errorMessage } from '../api';
import { ErrorBox, Section } from '../components';
import { JobRow, useJobRunner } from '../jobs';

type Info = Awaited<ReturnType<typeof api.appInfo>>;

export function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [usage, setUsage] = useState<{ used: number; limit: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    try {
      setSettings(await api.getSettings());
      setInfo(await api.appInfo());
      setUsage(await api.usage());
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
    </div>
  );
}
