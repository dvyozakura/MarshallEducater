import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EngineId } from '../../shared/engines';
import { classifyFailureText, type FailureKind } from '../../shared/failures';
import { codexArgs, geminiArgs, parseGeminiJson, resolveEngineCommand } from './engines';

/** 教員エンジンの呼び出しに使う設定(アプリの設定から作る)。名前は Claude だけだった頃のまま。 */
export interface ClaudeSettings {
  /** どのエンジンか。無ければ Claude Code。 */
  engine?: EngineId;
  /** コマンドの場所。空なら PATH から探す(Claude なら `claude`)。 */
  claudePath: string;
  /** モデル(別名か正式名)。空なら指定しない。 */
  model: string;
  /** 1回の呼び出しの制限時間(ミリ秒)。 */
  timeoutMs: number;
  /** 子プロセスに足す環境変数(テストで偽 Claude の制御ファイルを渡すのに使う)。 */
  extraEnv?: Record<string, string>;
}

export interface RunOptions {
  cwd: string;
  prompt: string;
  settings: ClaudeSettings;
  signal?: AbortSignal;
  resumeSessionId?: string;
  /** 添付する画像(絶対パス。Codex CLI の -i)。 */
  images?: string[];
  /** 最後の返答を書かせるファイル(Codex CLI の -o)。 */
  lastMessageFile?: string;
}

export interface RunResult {
  ok: boolean;
  failure?: FailureKind;
  /** 失敗の詳細(出力の先頭など)。 */
  message?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 最後の返答文。 */
  resultText?: string;
  sessionId?: string;
  /** エンジンが知らせた実際のモデル(分かるときだけ。Codex の既定のモデルなど)。 */
  model?: string;
  durationMs: number;
  command: string;
}

export function isFakeClaude(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ME_FAKE_CLAUDE === '1';
}

export function fakeClaudePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ME_FAKE_CLAUDE_PATH ?? resolve(process.cwd(), 'Tools/fake-claude/fake-claude.mjs');
}

export function engineOf(settings: ClaudeSettings): EngineId {
  return settings.engine ?? 'claude';
}

/** Claude Code の非対話実行の引数(DECISIONS.md「Claude Code の呼び出し方」)。プロンプトは標準入力で渡す。 */
export function buildArgs(settings: ClaudeSettings, resumeSessionId?: string): string[] {
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--tools', 'Read,Write,Edit,Glob,Grep'];
  if (settings.model.trim()) args.push('--model', settings.model.trim());
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  return args;
}

/** エンジンごとの引数。 */
export function engineArgsFor(opts: RunOptions): string[] {
  const engine = engineOf(opts.settings);
  if (engine === 'codex') return codexArgs({ cwd: opts.cwd, model: opts.settings.model, images: opts.images ?? [], lastMessageFile: opts.lastMessageFile ?? '' });
  if (engine === 'gemini') return geminiArgs({ model: opts.settings.model });
  return buildArgs(opts.settings, opts.resumeSessionId);
}

function fakeControl(env: NodeJS.ProcessEnv): Record<string, unknown> | null {
  const control = env.ME_FAKE_CONTROL;
  if (!control || !existsSync(control)) return null;
  try {
    return JSON.parse(readFileSync(control, 'utf8'));
  } catch {
    return null; // 制御ファイルが壊れていても偽 Claude 側で扱う
  }
}

function resolveCommand(opts: RunOptions, env: NodeJS.ProcessEnv): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const engine = engineOf(opts.settings);
  const args = engineArgsFor(opts);
  if (isFakeClaude(env)) {
    // 偽エンジン。「入っていない」の再現だけは、存在しないコマンドを起動して本物と同じ経路を通す。
    const c = fakeControl(env);
    const notFound = engine === 'claude' ? !!c?.notFound : Array.isArray(c?.notFoundEngines) && (c.notFoundEngines as string[]).includes(engine);
    if (notFound) return { command: `me-${engine}-not-installed`, args, env };
    return { command: process.execPath, args: [fakeClaudePath(env), ...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1', ME_FAKE_ENGINE: engine } };
  }
  if (engine === 'claude') return { command: opts.settings.claudePath.trim() || 'claude', args, env };
  const r = resolveEngineCommand(engine, opts.settings.claudePath, env);
  return { command: r.command, args: [...r.prefix, ...args], env: r.env };
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // 子が起こした孫プロセスも含めて止める
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

function parseResultJson(stdout: string): { result?: string; session_id?: string; is_error?: boolean } | null {
  const text = stdout.trim();
  if (!text) return null;
  const candidates = [text, ...text.split(/\r?\n/).reverse()];
  for (const c of candidates) {
    const s = c.trim();
    if (!s.startsWith('{')) continue;
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object') return v;
    } catch {
      /* 次の候補へ */
    }
  }
  return null;
}

interface Parsed {
  ok: boolean;
  resultText?: string;
  sessionId?: string;
  /** エンジンが知らせた実際のモデル(分かるときだけ)。 */
  model?: string;
  /** 失敗のときに見分けに使う文。 */
  detail: string;
}

/** 終わったあとの出力を、エンジンごとに読む。 */
function parseOutput(engine: EngineId, code: number | null, stdout: string, stderr: string, lastMessageFile?: string): Parsed {
  if (engine === 'codex') {
    let last: string | undefined;
    if (lastMessageFile && existsSync(lastMessageFile)) {
      last = readFileSync(lastMessageFile, 'utf8');
      rmSync(lastMessageFile, { force: true });
    }
    const resultText = last ?? (stdout.trim() || undefined);
    // Codex は最初に「model: gpt-…」を標準エラーに出す。モデルを指定しなかったときの記録に使う
    const model = stderr.match(/^model:\s*(\S+)\s*$/m)?.[1];
    return { ok: code === 0, resultText, model, detail: [stderr, stdout].join('\n').trim() };
  }
  if (engine === 'gemini') {
    const g = parseGeminiJson(stdout);
    const resultText = g?.response;
    // 終了コード 41 は認証の失敗(公式の troubleshooting)
    const auth = code === 41 ? 'gemini: authentication failed (exit 41)' : '';
    return { ok: code === 0 && !g?.error, resultText, detail: [auth, g?.error ?? '', stderr, g ? '' : stdout].join('\n').trim() };
  }
  const parsed = parseResultJson(stdout);
  const resultText = typeof parsed?.result === 'string' ? parsed.result : undefined;
  const sessionId = typeof parsed?.session_id === 'string' ? parsed.session_id : undefined;
  return { ok: code === 0 && parsed?.is_error !== true, resultText, sessionId, detail: [resultText ?? '', stderr, parsed ? '' : stdout].join('\n').trim() };
}

/** エンジン(または偽エンジン)を1回だけ非対話で呼ぶ。例外は投げず、結果を返す。 */
export function runClaude(opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const engine = engineOf(opts.settings);
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.settings.extraEnv ?? {}) };
  const { command, args, env: childEnv } = resolveCommand(opts, env);
  const commandText = `${command} ${args.join(' ')}`;

  return new Promise<RunResult>((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let ended: 'timeout' | 'canceled' | null = null;

    const finish = (r: Omit<RunResult, 'durationMs' | 'stdout' | 'stderr' | 'command'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolvePromise({ ...r, stdout, stderr, durationMs: Date.now() - started, command: commandText });
    };

    if (opts.signal?.aborted) {
      settled = true;
      resolvePromise({ ok: false, failure: 'canceled', message: '取り消しました', exitCode: null, stdout, stderr, durationMs: 0, command: commandText });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd: opts.cwd, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      settled = true;
      resolvePromise({ ok: false, failure: 'not_found', message: String((e as Error).message), exitCode: null, stdout, stderr, durationMs: 0, command: commandText });
      return;
    }

    const onAbort = () => {
      ended = 'canceled';
      killTree(child);
    };
    opts.signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      ended = 'timeout';
      killTree(child);
    }, opts.settings.timeoutMs);

    child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') {
        finish({ ok: false, failure: 'not_found', message: `${command} を起動できませんでした`, exitCode: null });
      } else {
        finish({ ok: false, failure: 'other', message: e.message, exitCode: null });
      }
    });
    child.stdin?.on('error', () => {
      /* 起動に失敗したときの EPIPE は 'error' 側で扱う */
    });
    child.stdin?.end(opts.prompt, 'utf8');

    child.on('close', (code) => {
      if (ended === 'timeout') {
        finish({ ok: false, failure: 'timeout', message: `制限時間(${Math.round(opts.settings.timeoutMs / 1000)}秒)を超えました`, exitCode: code });
        return;
      }
      if (ended === 'canceled') {
        finish({ ok: false, failure: 'canceled', message: '取り消しました', exitCode: code });
        return;
      }
      const p = parseOutput(engine, code, stdout, stderr, opts.lastMessageFile);
      if (p.ok) {
        finish({ ok: true, exitCode: code, resultText: p.resultText, sessionId: p.sessionId, model: p.model });
        return;
      }
      finish({
        ok: false,
        failure: classifyFailureText(p.detail, engine),
        message: p.detail.slice(0, 500) || `終了コード ${code}`,
        exitCode: code,
        resultText: p.resultText,
        sessionId: p.sessionId,
      });
    });
  });
}

/** 名前を分かりやすくした別名。 */
export const runEngine = runClaude;
