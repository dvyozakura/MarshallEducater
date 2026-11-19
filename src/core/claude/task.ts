import { existsSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { ENGINE_CAPS, ENGINE_SHORT, type EngineId, type MadeBy } from '../../shared/engines';
import type { FailureKind } from '../../shared/failures';
import { classifyFailureText, failureTitle } from '../../shared/failures';
import { ensureDir, newId, writeFileAtomic } from '../fsutil';
import { extractJsonText } from './engines';
import type { DailyLimiter } from './limiter';
import { buildPrompt, type PromptKind } from './prompts';
import { engineOf, runClaude, type ClaudeSettings, type RunResult } from './runner';

/** 型に合わない出力のとき、やり直させる回数の上限(最初の1回+やり直し2回)。 */
export const MAX_RETRIES = 2;

export class ClaudeError extends Error {
  constructor(
    public readonly kind: FailureKind,
    public readonly detail: string,
    /** どのエンジンでの失敗か。 */
    public readonly engine: EngineId = 'claude',
  ) {
    super(`${failureTitle(kind, engine)}${detail ? `: ${detail}` : ''}`);
    this.name = 'ClaudeError';
  }
}

/** 呼び出しごとに選んだエンジン。 */
export interface EngineSelection {
  settings: ClaudeSettings;
  limiter?: DailyLimiter;
  /** 割り当てを代えた理由など(記録に残す)。 */
  note?: string;
}

export interface ClaudeEnv {
  /** Claude Code の設定(エンジンを選ぶ仕組みが無いときは、これを使う)。 */
  settings: ClaudeSettings;
  limiter?: DailyLimiter;
  /** プロンプトの種類(→ 役割)とプロジェクトから、使うエンジンを選ぶ(アプリの設定 → プロジェクトの上書き → 役割ごと)。 */
  select?: (kind: PromptKind, projectDir: string, engine?: EngineId) => EngineSelection;
}

/** JSON の中の画像ファイル(.png/.jpg)のパスを集める(作業フォルダからの相対パスも絶対パスにする)。 */
export function collectImages(input: unknown, projectDir: string): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/\.(png|jpe?g)$/i.test(v) && v.length < 500) {
        const abs = isAbsolute(v) ? v : join(projectDir, v);
        if (existsSync(abs)) out.add(abs);
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(input);
  return [...out];
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
  /** エンジンを名指しする(接続確認など)。無ければ役割の割り当てに従う。 */
  engine?: EngineId;
}

export interface StructuredResult<T> {
  data: T;
  /** 呼び出した回数(1〜3)。 */
  attempts: number;
  sessionId?: string;
  callId: string;
  /** どのエンジン・モデルで作ったか(成果物に記録する)。 */
  madeBy: MadeBy;
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
  const sel: EngineSelection = c.env.select ? c.env.select(c.kind, c.projectDir, c.engine) : { settings: c.env.settings, limiter: c.env.limiter };
  const engine = engineOf(sel.settings);
  const madeBy: MadeBy = { engine, model: sel.settings.model.trim() };
  // Claude 以外は、ファイルを読み書きさせず、入力をプロンプトに埋め込んで返答の JSON を受け取る(DECISIONS.md)
  const inline = engine !== 'claude';
  // 会話の続き(--resume)ができないエンジンでは使わない(やりとりは入力で渡している)
  const resumeSessionId = ENGINE_CAPS[engine].resume ? c.resumeSessionId : undefined;
  const callId = newId('call');
  const ioRel = `.me/io/${callId}`;
  const ioDir = join(c.projectDir, '.me', 'io', callId);
  ensureDir(ioDir);
  const inputRel = c.input === undefined ? null : `${ioRel}/input.json`;
  if (c.input !== undefined) writeFileAtomic(join(ioDir, 'input.json'), JSON.stringify(c.input, null, 1));
  const outputRel = `${ioRel}/output.json`;
  const outputFile = join(ioDir, 'output.json');
  const lastMessageFile = join(ioDir, 'last_message.txt');
  const images = inline ? collectImages(c.input, c.projectDir) : [];

  let retryError: string | undefined;
  let lastRun: RunResult | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    if (c.signal?.aborted) throw new ClaudeError('canceled', '', engine);
    if (sel.limiter && !sel.limiter.tryConsume()) {
      throw new ClaudeError('daily_limit', `今日は ${ENGINE_SHORT[engine]} を ${sel.limiter.used()} 回呼び出しました(上限 ${sel.limiter.limit()} 回)`, engine);
    }
    const prompt = buildPrompt({
      kind: c.kind,
      vars: c.vars ?? {},
      inputFile: inputRel,
      outputFile: outputRel,
      schema: c.schema,
      retryError,
      ...(inline ? { inline: { input: c.input, images } } : {}),
    });
    rmSync(outputFile, { force: true });
    rmSync(lastMessageFile, { force: true });
    const startedAt = new Date().toISOString();
    const run = await runClaude({ cwd: c.projectDir, prompt, settings: sel.settings, signal: c.signal, resumeSessionId, images, lastMessageFile });
    lastRun = run;
    const base = {
      callId,
      kind: c.kind,
      engine,
      model: madeBy.model,
      ...(sel.note ? { engineNote: sel.note } : {}),
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
      throw new ClaudeError(run.failure ?? 'other', run.message ?? '', engine);
    }
    if (inline) {
      // 返答の JSON を出力ファイルに書き、Claude と同じ検証を通す
      const json = run.resultText ? extractJsonText(run.resultText) : null;
      if (json !== null) writeFileAtomic(outputFile, json);
    }
    const v = readAndValidate(outputFile, c.schema, c.check);
    if (v.ok) {
      writeLog(c.projectDir, callId, c.kind, attempt, { ...base, outcome: 'ok', output: v.data });
      rmSync(ioDir, { recursive: true, force: true });
      return { data: v.data, attempts: attempt, sessionId: run.sessionId, callId, madeBy };
    }
    const rawOutput = existsSync(outputFile) ? readFileSync(outputFile, 'utf8').slice(0, 20000) : null;
    writeLog(c.projectDir, callId, c.kind, attempt, { ...base, outcome: 'invalid_output', validationError: v.error, rawOutput });
    // 終了コードは成功なのに、返答文が「ログイン切れ・使用量の上限」だけで出力ファイルが無いことがある。やり直しても無駄なので、すぐ失敗にする。
    if (rawOutput === null && run.resultText && run.resultText.length < 400) {
      const k = classifyFailureText(run.resultText, engine);
      if (k === 'not_logged_in' || k === 'usage_limit') throw new ClaudeError(k, run.resultText, engine);
    }
    retryError = inline && rawOutput === null ? `返答に JSON がありませんでした。最後の返答として JSON だけを書いてください。` : v.error;
  }
  rmSync(ioDir, { recursive: true, force: true });
  throw new ClaudeError('invalid_output', `${retryError ?? ''}${lastRun?.resultText ? `\n(${ENGINE_SHORT[engine]} の返答: ${lastRun.resultText.slice(0, 200)})` : ''}`, engine);
}
