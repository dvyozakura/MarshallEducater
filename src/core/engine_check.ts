// 教員エンジンごとの接続確認(設定画面)。版の確認 → 短い呼び出し1回(ping)で、入っていない・未ログイン・使用量の上限を見分ける。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { ENGINE_IDS, ENGINE_SHORT, EngineStatusSchema, type EngineId, type EngineStatus, type EngineStatusKind } from '../shared/engines';
import { PingOutputSchema } from '../shared/schema';
import type { AppCore } from './app';
import { resolveEngineCommand } from './claude/engines';
import { fakeClaudePath, isFakeClaude } from './claude/runner';
import { callClaude, ClaudeError } from './claude/task';
import { ensureDir } from './fsutil';
import type { JobContext } from './jobs';

/** --version で版を調べる。起動できなければ null。 */
export function engineVersion(core: AppCore, engine: EngineId): string | null {
  const s = core.engineSettings(engine);
  const env: NodeJS.ProcessEnv = { ...process.env, ...(s.extraEnv ?? {}) };
  let command: string;
  let args: string[];
  let childEnv = env;
  if (isFakeClaude(env)) {
    try {
      const c = env.ME_FAKE_CONTROL && existsSync(env.ME_FAKE_CONTROL) ? JSON.parse(readFileSync(env.ME_FAKE_CONTROL, 'utf8')) : {};
      if (engine === 'claude' ? c.notFound : (c.notFoundEngines ?? []).includes(engine)) return null;
    } catch {
      /* 制御ファイルが無い・壊れている */
    }
    command = process.execPath;
    args = [fakeClaudePath(env), '--version'];
    childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1', ME_FAKE_ENGINE: engine };
  } else if (engine === 'claude') {
    command = s.claudePath.trim() || 'claude';
    args = ['--version'];
  } else {
    const r = resolveEngineCommand(engine, s.claudePath, env);
    command = r.command;
    args = [...r.prefix, '--version'];
    childEnv = r.env;
  }
  const r = spawnSync(command, args, { env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').trim().split(/\r?\n/)[0] ?? '';
}

function saveStatus(core: AppCore, st: EngineStatus): void {
  const list = core.getSettings().engineStatus.filter((s) => s.engine !== st.engine);
  core.updateSettings({ engineStatus: [...list, EngineStatusSchema.parse(st)].sort((a, b) => ENGINE_IDS.indexOf(a.engine) - ENGINE_IDS.indexOf(b.engine)) });
}

/** 接続確認のジョブの中身。結果は設定(engineStatus)に残し、失敗なら案内つきの失敗にする。 */
export async function checkEngine(core: AppCore, engine: EngineId, ctx: JobContext): Promise<{ engine: EngineId; ok: true; message: string; version: string }> {
  const at = new Date().toISOString();
  ctx.progress(`${ENGINE_SHORT[engine]} が入っているかを確かめています`);
  const version = engineVersion(core, engine);
  if (version === null) {
    saveStatus(core, { engine, status: 'not_found', version: '', message: '', checkedAt: at });
    throw new ClaudeError('not_found', `${ENGINE_SHORT[engine]} のコマンドを起動できませんでした`, engine);
  }
  const dir = core.dataDir();
  ensureDir(dir);
  ctx.progress(`${ENGINE_SHORT[engine]} の返事を待っています`);
  try {
    const r = await callClaude({ projectDir: dir, kind: 'ping', vars: { note: '' }, schema: PingOutputSchema, env: core.claudeEnv(), signal: ctx.signal, engine });
    saveStatus(core, { engine, status: 'ok', version, message: r.data.message, checkedAt: at });
    return { engine, ok: true, message: r.data.message, version };
  } catch (e) {
    const kind = e instanceof ClaudeError ? e.kind : 'other';
    const status: EngineStatusKind = kind === 'not_found' || kind === 'not_logged_in' || kind === 'usage_limit' ? kind : kind === 'canceled' ? 'unchecked' : 'error';
    saveStatus(core, { engine, status, version, message: e instanceof Error ? e.message.slice(0, 300) : String(e), checkedAt: at });
    throw e;
  }
}
