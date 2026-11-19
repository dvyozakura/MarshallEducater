// 教員エンジン(Claude・ChatGPT・Gemini)の設定: 接続確認、既定のエンジン、役割ごとの割り当て、検算を別の AI に、プロジェクトごとの上書き。
import { useEffect, useState } from 'react';
import {
  ENGINE_IDS,
  ENGINE_LABEL,
  ENGINE_ROLE_LABEL,
  ENGINE_ROLE_NOTE,
  ENGINE_ROLES,
  ENGINE_SHORT,
  ENGINE_STATUS_LABEL,
  engineAllowedForRole,
  type EngineAssign,
  type EngineId,
  type EngineRole,
} from '../../shared/engines';
import type { AppSettings } from '../../shared/schema';
import { api, errorMessage } from '../api';
import { ErrorBox, Section } from '../components';
import { JobRow, useJobRunner } from '../jobs';

type EngineInfo = Awaited<ReturnType<typeof api.engineInfo>>;

/** 役割ごとに、実際に使うエンジン(割り当ての結果)。 */
function ResolvedList({ info }: { info: EngineInfo }) {
  return (
    <ul className="plain" data-testid="engine-resolved">
      {info.resolved.map((r) => (
        <li key={r.role} data-testid={`resolved-${r.role}`} data-engine={r.engine}>
          {ENGINE_ROLE_LABEL[r.role]}: <strong>{ENGINE_SHORT[r.engine]}</strong>
          {r.note && <span className="hint inline">({r.note})</span>}
        </li>
      ))}
    </ul>
  );
}

function CheckButton({ engine, onDone }: { engine: EngineId; onDone: () => void }) {
  const run = useJobRunner(onDone);
  return (
    <div>
      <button className="small" data-testid={`engine-check-${engine}`} disabled={run.busy} onClick={() => void run.start(() => api.startPing(engine)).then(onDone)}>
        接続を確認する
      </button>
      {run.job && run.job.status !== 'done' && <JobRow job={run.job} onRetry={() => void run.start(() => api.startPing(engine)).then(onDone)} />}
      <ErrorBox message={run.startError} />
    </div>
  );
}

/** 役割ごとの割り当ての選択欄。value が undefined なら「既定に従う」。 */
function RoleSelect({ role, value, onChange, testPrefix }: { role: EngineRole; value: EngineId | undefined; onChange: (v: EngineId | undefined) => void; testPrefix: string }) {
  return (
    <label>
      <span>{ENGINE_ROLE_LABEL[role]}</span>
      <span>
        <select data-testid={`${testPrefix}-role-${role}`} value={value ?? ''} onChange={(e) => onChange((e.target.value || undefined) as EngineId | undefined)}>
          <option value="">既定に従う</option>
          {ENGINE_IDS.filter((id) => engineAllowedForRole(id, role)).map((id) => (
            <option key={id} value={id}>
              {ENGINE_LABEL[id]}
            </option>
          ))}
        </select>
        <span className="hint inline">{ENGINE_ROLE_NOTE[role]}</span>
      </span>
    </label>
  );
}

/**
 * アプリ全体の設定(設定画面)。値の変更は settings に入れ、設定画面の「保存する」で保存する。
 */
export function EngineSettingsSection({ settings, set, savedCount }: { settings: AppSettings; set: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void; savedCount: number }) {
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof api.engineUsage>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => {
    void api.engineInfo(null).then(setInfo, (e) => setError(errorMessage(e)));
    void api.engineUsage().then(setUsage, () => {});
  };
  useEffect(reload, [savedCount]);
  if (!info) return <ErrorBox message={error} />;

  const setEngine = (id: 'codex' | 'gemini', patch: Partial<AppSettings['engines']['codex']>) => set('engines', { ...settings.engines, [id]: { ...settings.engines[id], ...patch } });
  const setRole = (role: EngineRole, v: EngineId | undefined) => {
    const roles = { ...settings.engineRoles };
    if (v) roles[role] = v;
    else delete roles[role];
    set('engineRoles', roles);
  };

  return (
    <Section title="教員エンジン(Claude・ChatGPT・Gemini)" testId="engines">
      <div className="hint">
        教える側の仕事を担当する AI です。どれも公式のコマンドラインツールを、あなた自身のログインのまま呼び出します(アプリは API キーを預かりません)。
        入っていない・ログインしていないエンジンがあっても、Claude だけで全部動きます。
      </div>
      <table className="grid" data-testid="engine-table">
        <tbody>
          {info.engines.map((e) => {
            const u = usage?.find((x) => x.engine === e.engine);
            return (
              <tr key={e.engine} data-testid={`engine-row-${e.engine}`} data-status={e.status.status}>
                <th>{e.label}</th>
                <td>
                  <span data-testid={`engine-status-${e.engine}`}>{ENGINE_STATUS_LABEL[e.status.status]}</span>
                  {e.status.version && <span className="muted"> ・ 版 {e.status.version}</span>}
                  {u && (
                    <span className="muted" data-testid={`engine-usage-${e.engine}`}>
                      {' '}
                      ・ 今日 {u.used} / {u.limit} 回
                    </span>
                  )}
                  {e.status.status !== 'ok' && e.status.status !== 'unchecked' && e.status.message && <div className="hint">{e.status.message}</div>}
                  {!e.caps.images && <div className="hint">画像を読めないので、読み取りには使えません。</div>}
                  {!e.caps.resume && <div className="hint">会話の続きは、これまでのやりとりをプロンプトに入れて代用します。</div>}
                </td>
                <td>
                  <CheckButton engine={e.engine} onDone={reload} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="form">
        {(['codex', 'gemini'] as const).map((id) => (
          <fieldset key={id} className="engine-config">
            <legend>{ENGINE_LABEL[id]}</legend>
            <label>
              <span>{id} の場所</span>
              <input data-testid={`s-${id}-path`} value={settings.engines[id].path} onChange={(e) => setEngine(id, { path: e.target.value })} placeholder={`空なら自動で探します(PATH の ${id})`} />
            </label>
            <label>
              <span>モデル</span>
              <input data-testid={`s-${id}-model`} value={settings.engines[id].model} onChange={(e) => setEngine(id, { model: e.target.value })} placeholder="空ならツールの既定" />
            </label>
            <label>
              <span>1日の上限(回)</span>
              <input
                data-testid={`s-${id}-dailyLimit`}
                type="number"
                min={1}
                value={settings.engines[id].dailyLimit}
                onChange={(e) => setEngine(id, { dailyLimit: Math.max(1, Math.min(100000, Math.round(Number(e.target.value) || 1))) })}
              />
            </label>
          </fieldset>
        ))}
        <label>
          <span>既定のエンジン</span>
          <select data-testid="s-defaultEngine" value={settings.defaultEngine} onChange={(e) => set('defaultEngine', e.target.value as EngineId)}>
            {ENGINE_IDS.map((id) => (
              <option key={id} value={id}>
                {ENGINE_LABEL[id]}
              </option>
            ))}
          </select>
        </label>
        {ENGINE_ROLES.map((role) => (
          <RoleSelect key={role} role={role} value={settings.engineRoles[role]} onChange={(v) => setRole(role, v)} testPrefix="s" />
        ))}
        <label>
          <span>検算</span>
          <span>
            <input type="checkbox" data-testid="s-verifyWithOther" checked={settings.verifyWithOther} onChange={(e) => set('verifyWithOther', e.target.checked)} /> 検算は問題作成と別の AI にする
            <span className="hint inline">同じ AI の思い込みを避けるため。つながっているほかのエンジンが無いときは、同じエンジンで検算します。</span>
          </span>
        </label>
      </div>
      <div className="hint">保存したあとの、役割ごとに実際に使うエンジン:</div>
      <ResolvedList info={info} />
    </Section>
  );
}

/** プロジェクトごとの上書き(プロジェクトのダッシュボード)。 */
export function ProjectEnginesSection({ projectId }: { projectId: string }) {
  const [assign, setAssign] = useState<EngineAssign | null>(null);
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void api.getProject(projectId).then((p) => setAssign(p.engines ?? null), (e) => setError(errorMessage(e)));
    void api.engineInfo(projectId).then(setInfo, () => {});
  }, [projectId]);

  const cur: EngineAssign = assign ?? { defaultEngine: null, roles: {}, verifyWithOther: null };
  const update = (patch: Partial<EngineAssign>) => {
    setAssign({ ...cur, ...patch });
    setSaved(false);
  };
  const save = async (value: EngineAssign | null) => {
    setError(null);
    try {
      const p = await api.setProjectEngines(projectId, value);
      setAssign(p.engines ?? null);
      setInfo(await api.engineInfo(projectId));
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const overridden = !!assign && (assign.defaultEngine !== null || Object.keys(assign.roles).length > 0 || assign.verifyWithOther !== null);

  return (
    <Section
      title="教員エンジン(このプロジェクト)"
      testId="project-engines"
      actions={
        <button className="small" data-testid="project-engines-toggle" onClick={() => setOpen(!open)}>
          {open ? '閉じる' : '割り当てを変える'}
        </button>
      }
    >
      {info && (
        <div className="hint" data-testid="project-engines-summary">
          {overridden ? 'このプロジェクトだけの割り当てがあります。' : 'アプリ全体の設定に従っています。'}
          {info.resolved.map((r) => `${ENGINE_ROLE_LABEL[r.role]}: ${ENGINE_SHORT[r.engine]}`).join(' ・ ')}
        </div>
      )}
      {open && (
        <>
          <div className="form">
            <label>
              <span>既定のエンジン</span>
              <select data-testid="p-defaultEngine" value={cur.defaultEngine ?? ''} onChange={(e) => update({ defaultEngine: (e.target.value || null) as EngineId | null })}>
                <option value="">アプリ全体の設定に従う</option>
                {ENGINE_IDS.map((id) => (
                  <option key={id} value={id}>
                    {ENGINE_LABEL[id]}
                  </option>
                ))}
              </select>
            </label>
            {ENGINE_ROLES.map((role) => (
              <RoleSelect
                key={role}
                role={role}
                value={cur.roles[role]}
                testPrefix="p"
                onChange={(v) => {
                  const roles = { ...cur.roles };
                  if (v) roles[role] = v;
                  else delete roles[role];
                  update({ roles });
                }}
              />
            ))}
            <label>
              <span>検算を別の AI に</span>
              <select
                data-testid="p-verifyWithOther"
                value={cur.verifyWithOther === null ? '' : cur.verifyWithOther ? 'on' : 'off'}
                onChange={(e) => update({ verifyWithOther: e.target.value === '' ? null : e.target.value === 'on' })}
              >
                <option value="">アプリ全体の設定に従う</option>
                <option value="on">する</option>
                <option value="off">しない</option>
              </select>
            </label>
          </div>
          <div className="buttons">
            <button className="primary" data-testid="project-engines-save" onClick={() => void save(cur)}>
              保存する
            </button>
            <button data-testid="project-engines-reset" onClick={() => void save(null)}>
              アプリ全体の設定に戻す
            </button>
            {saved && <span className="hint" data-testid="project-engines-saved">保存しました</span>}
          </div>
          {info && <ResolvedList info={info} />}
        </>
      )}
      <ErrorBox message={error} />
    </Section>
  );
}
