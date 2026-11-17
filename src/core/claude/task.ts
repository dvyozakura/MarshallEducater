import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { FailureKind } from '../../shared/failures';
import { failureTitle } from '../../shared/failures';
import { ensureDir, newId, writeFileAtomic } from '../fsutil';
import type { DailyLimiter } from './limiter';
import { buildPrompt, type PromptKind } from './prompts';
import { runClaude, type ClaudeSettings, type RunResult } from './runner';

/** 型に合わない出力のとき、やり直させる回数の上限(最初の1回+やり直し2回)。 */
export const MAX_RETRIES = 2;

export class ClaudeError extends Error {
  constructor(
    public readonly kind: FailureKind,
    public readonly detail: string,
  ) {
    super(`${failureTitle(kind)}${detail ? `: ${detail}` : ''}`);
    this.name = 'ClaudeError';
  }
}

export interface ClaudeEnv {
  settings: ClaudeSettings;
  limiter?: DailyLimiter;
}

export interface StructuredCall<T> {
  /** 作業フォルダ(プロジェクトのフォルダ)。 */
  projectDir: string;
  kind: PromptKind;
  /** プロンプト本文の `{{名前}}` に入れる値。 */
  vars?: Record<string, string>;
  /** 入力ファイルとして置く内容(JSON)。 */
  input?: unknown;
  /** 出力の型。 */
  schema: z.ZodType<T>;
  env: ClaudeEnv;
  signal?: AbortSignal;
  resumeSessionId?: string;
  /** 型は合っているが中身がおかしい、を追加で調べる(問題があれば理由を返す)。 */
  check?: (data: T) => string | null;
}

export interface StructuredResult<T> {
  data: T;
  /** 呼び出した回数(1〜3)。 */
  attempts: number;
  sessionId?: string;
  callId: string;
}

function describeZodError(e: z.ZodError): string {
  return e.issues
    .slice(0, 12)
    .map((i) => `- ${i.path.length ? i.path.join('.') : '(全体)'}: ${i.message}`)
    .join('\n');
}

/** 出力ファイルを読み、JSON として解釈し、型で検証する。 */
export function readAndValidate<T>(file: string, schema: z.ZodType<T>, check?: (d: T) => string | null): { ok: true; data: T } | { ok: false; error: string } {
  if (!existsSync(file)) return { ok: false, error: '出力ファイルが書かれていません。' };
  let text = readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // よくある失敗: ```json ... ``` で囲んでしまう
  const fenced = text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fenced) text = fenced[1];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `JSON として読めません: ${(e as Error).message}` };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `形式が合っていません:\n${describeZodError(parsed.error)}` };
  const problem = check?.(parsed.data) ?? null;
  if (problem) return { ok: false, error: problem };
  return { ok: true, data: parsed.data };
}

function writeLog(projectDir: string, callId: string, kind: string, attempt: number, record: Record<string, unknown>): void {
  try {
    writeFileAtomic(join(projectDir, 'logs', `${callId}_${kind}_${attempt}.json`), JSON.stringify(record, null, 1));
  } catch {
    /* 記録の失敗で本体を止めない */
  }
}

/**
 * Claude を呼び、出力ファイル(JSON)を型で検証して返す。
 * 出力が壊れていたら、エラー内容を添えて最大2回やり直させる。呼び出しのたびに logs/ に記録を残す。
 */
export async function callClaude<T>(c: StructuredCall<T>): Promise<StructuredResult<T>> {
  const callId = newId('call');
  const ioRel = `.me/io/${callId}`;
  const ioDir = join(c.projectDir, '.me', 'io', callId);
  ensureDir(ioDir);
  const inputRel = c.input === undefined ? null : `${ioRel}/input.json`;
  if (c.input !== undefined) writeFileAtomic(join(ioDir, 'input.json'), JSON.stringify(c.input, null, 1));
  const outputRel = `${ioRel}/output.json`;
  const outputFile = join(ioDir, 'output.json');

  let retryError: string | undefined;
  let lastRun: RunResult | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    if (c.signal?.aborted) throw new ClaudeError('canceled', '');
    if (c.env.limiter && !c.env.limiter.tryConsume()) {
      throw new ClaudeError('daily_limit', `今日は ${c.env.limiter.used()} 回呼び出しました(上限 ${c.env.limiter.limit()} 回)`);
    }
    const prompt = buildPrompt({ kind: c.kind, vars: c.vars ?? {}, inputFile: inputRel, outputFile: outputRel, schema: c.schema, retryError });
    rmSync(outputFile, { force: true });
    const startedAt = new Date().toISOString();
    const run = await runClaude({ cwd: c.projectDir, prompt, settings: c.env.settings, signal: c.signal, resumeSessionId: c.resumeSessionId });
    lastRun = run;
    const base = {
      callId,
      kind: c.kind,
      attempt,
      startedAt,
      durationMs: run.durationMs,
      command: run.command,
      exitCode: run.exitCode,
      prompt,
      resultText: run.resultText ?? null,
      sessionId: run.sessionId ?? null,
      stderr: run.stderr.slice(0, 4000),
    };
    if (!run.ok) {
      writeLog(c.projectDir, callId, c.kind, attempt, { ...base, outcome: 'failed', failure: run.failure, message: run.message, stdout: run.stdout.slice(0, 4000) });
      throw new ClaudeError(run.failure ?? 'other', run.message ?? '');
    }
    const v = readAndValidate(outputFile, c.schema, c.check);
    if (v.ok) {
      writeLog(c.projectDir, callId, c.kind, attempt, { ...base, outcome: 'ok', output: v.data });
      rmSync(ioDir, { recursive: true, force: true });
      return { data: v.data, attempts: attempt, sessionId: run.sessionId, callId };
    }
    const rawOutput = existsSync(outputFile) ? readFileSync(outputFile, 'utf8').slice(0, 20000) : null;
    writeLog(c.projectDir, callId, c.kind, attempt, { ...base, outcome: 'invalid_output', validationError: v.error, rawOutput });
    retryError = v.error;
  }
  rmSync(ioDir, { recursive: true, force: true });
  throw new ClaudeError('invalid_output', `${retryError ?? ''}${lastRun?.resultText ? `\n(Claude の返答: ${lastRun.resultText.slice(0, 200)})` : ''}`);
}
