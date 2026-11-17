import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DailyLimiter } from '../../src/core/claude/limiter';
import { buildPrompt, renderTemplate, schemaDescription } from '../../src/core/claude/prompts';
import { runClaude } from '../../src/core/claude/runner';
import { callClaude, ClaudeError } from '../../src/core/claude/task';
import { JobQueue } from '../../src/core/jobs';
import { classifyFailureText } from '../../src/shared/failures';
import { fakeClaude, makeTmpDir } from './helpers';

const PingSchema = z.object({ ok: z.literal(true), message: z.string() });

function ping(dir: string, fake: ReturnType<typeof fakeClaude>, extra: Partial<Parameters<typeof callClaude>[0]> = {}) {
  return callClaude({ projectDir: dir, kind: 'ping', vars: { note: '' }, schema: PingSchema, env: { settings: fake.settings }, ...extra });
}

async function expectFailure(p: Promise<unknown>, kind: string): Promise<ClaudeError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ClaudeError);
    expect((e as ClaudeError).kind).toBe(kind);
    return e as ClaudeError;
  }
  throw new Error(`失敗(${kind})するはずが成功した`);
}

describe('プロンプトの組み立て', () => {
  it('変数を置き換え、足りない変数はエラーにする', () => {
    expect(renderTemplate('a{{x}}b', { x: '1' })).toBe('a1b');
    expect(() => renderTemplate('{{y}}', {})).toThrow(/y/);
  });
  it('種類・入出力のパス・型の説明が入る', () => {
    const p = buildPrompt({ kind: 'ping', vars: { note: '' }, inputFile: null, outputFile: '.me/io/x/output.json', schema: PingSchema });
    expect(p).toContain('ME_PROMPT_KIND: ping');
    expect(p).toContain('ME_INPUT_FILE: なし');
    expect(p).toContain('ME_OUTPUT_FILE: .me/io/x/output.json');
    expect(p).toContain('"message"');
    expect(schemaDescription(PingSchema)).toContain('"required"');
  });
});

describe('Claude の呼び出し(偽 Claude)', () => {
  it('成功: 出力を型で検証して返し、記録を logs/ に残す', async () => {
    const dir = makeTmpDir();
    const fake = fakeClaude(dir);
    const r = await ping(dir, fake);
    expect(r.data).toEqual({ ok: true, message: '接続できました' });
    expect(r.attempts).toBe(1);
    const logs = readdirSync(join(dir, 'logs'));
    expect(logs).toHaveLength(1);
    const log = JSON.parse(readFileSync(join(dir, 'logs', logs[0]), 'utf8'));
    expect(log.outcome).toBe('ok');
    expect(log.prompt).toContain('ME_PROMPT_KIND: ping');
    expect(typeof log.durationMs).toBe('number');
    // 受け渡し用の一時フォルダは片付ける
    expect(existsSync(join(dir, '.me', 'io', r.callId))).toBe(false);
  });

  it('やり直して成功: 壊れた JSON のあと、エラー内容を添えて呼び直す', async () => {
    const dir = makeTmpDir();
    const fake = fakeClaude(dir, { kinds: { ping: ['broken', 'ok'] } });
    const r = await ping(dir, fake);
    expect(r.attempts).toBe(2);
    const calls = fake.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0].prompt).not.toContain('やり直しのお願い');
    expect(calls[1].prompt).toContain('やり直しのお願い');
    expect(calls[1].prompt).toContain('JSON として読めません');
  });

  it('やり直して成功: 型に合わない JSON でもやり直す(2回まで)', async () => {
    const dir = makeTmpDir();
    const fake = fakeClaude(dir, { kinds: { ping: ['invalid', 'nofile', 'ok'] } });
    const r = await ping(dir, fake);
    expect(r.attempts).toBe(3);
    expect(fake.calls()[1].prompt).toContain('形式が合っていません');
    expect(fake.calls()[2].prompt).toContain('出力ファイルが書かれていません');
  });

  it('やり直しても失敗: 3回とも壊れていたら invalid_output', async () => {
    const dir = makeTmpDir();
    const fake = fakeClaude(dir, { kinds: { ping: ['broken', 'invalid', 'broken', 'ok'] } });
    await expectFailure(ping(dir, fake), 'invalid_output');
    expect(fake.calls()).toHaveLength(3);
    expect(readdirSync(join(dir, 'logs'))).toHaveLength(3);
  });

  it('時間切れ', async () => {
    const dir = makeTmpDir();
    const fake = fakeClaude(dir, { default: 'slow', slowMs: 30000 }, 700);
    const started = Date.now();
    await expectFailure(ping(dir, fake), 'timeout');
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it('取り消し', async () => {
    const dir = makeTmpDir();
    const fake = fakeClaude(dir, { default: 'slow', slowMs: 30000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    const started = Date.now();
    await expectFailure(ping(dir, fake, { signal: ac.signal }), 'canceled');
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it('1日の上限超過: 上限に達したら呼び出さずに daily_limit', async () => {
    const dir = makeTmpDir();
    const fake = fakeClaude(dir);
    const limiter = new DailyLimiter(join(dir, 'usage.json'), () => 2);
    const env = { settings: fake.settings, limiter };
    await callClaude({ projectDir: dir, kind: 'ping', vars: { note: '' }, schema: PingSchema, env });
    await callClaude({ projectDir: dir, kind: 'ping', vars: { note: '' }, schema: PingSchema, env });
    await expectFailure(callClaude({ projectDir: dir, kind: 'ping', vars: { note: '' }, schema: PingSchema, env }), 'daily_limit');
    expect(fake.calls()).toHaveLength(2);
    expect(limiter.used()).toBe(2);
  });

  it('claude が無い/未ログイン/使用量上限/通信失敗 を見分ける', async () => {
    const dir = makeTmpDir();
    const fake = fakeClaude(dir, { notFound: true });
    await expectFailure(ping(dir, fake), 'not_found');
    fake.set({ default: 'not_logged_in' });
    await expectFailure(ping(dir, fake), 'not_logged_in');
    fake.set({ default: 'usage_limit' });
    const e = await expectFailure(ping(dir, fake), 'usage_limit');
    expect(e.detail).toContain('resets');
    fake.set({ default: 'network' });
    await expectFailure(ping(dir, fake), 'network');
    fake.set({ default: 'fail' });
    await expectFailure(ping(dir, fake), 'other');
  });

  it('本物の claude の場所が間違っていれば not_found', async () => {
    const dir = makeTmpDir();
    const r = await runClaude({
      cwd: dir,
      prompt: 'x',
      settings: { claudePath: join(dir, 'no-such-claude.exe'), model: '', timeoutMs: 5000, extraEnv: { ME_FAKE_CLAUDE: '0' } },
    });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe('not_found');
  });

  it('続きの会話: --resume に session_id を渡す', async () => {
    const dir = makeTmpDir();
    const fake = fakeClaude(dir);
    const first = await ping(dir, fake);
    expect(first.sessionId).toBeTruthy();
    const second = await ping(dir, fake, { resumeSessionId: first.sessionId });
    expect(second.sessionId).toBe(first.sessionId);
    expect(fake.calls()[1].argv).toContain('--resume');
  });
});

describe('失敗の文言の見分け', () => {
  it('実際の文言', () => {
    expect(classifyFailureText("You've hit your 5-hour limit · resets 12:30am (Asia/Tokyo)")).toBe('usage_limit');
    expect(classifyFailureText('Invalid API key · Please run /login')).toBe('not_logged_in');
    expect(classifyFailureText('API Error: Connection error.')).toBe('network');
    expect(classifyFailureText('何かの失敗')).toBe('other');
  });
});

describe('1日の上限の数え方', () => {
  it('日付が変わると 0 に戻る。起動し直しても続きから数える', () => {
    const dir = makeTmpDir();
    let now = new Date(2026, 0, 10, 23, 0);
    const file = join(dir, 'usage.json');
    const a = new DailyLimiter(file, () => 3, () => now);
    expect(a.tryConsume()).toBe(true);
    expect(a.tryConsume()).toBe(true);
    const b = new DailyLimiter(file, () => 3, () => now);
    expect(b.used()).toBe(2);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(false);
    now = new Date(2026, 0, 11, 0, 1);
    expect(b.used()).toBe(0);
    expect(b.tryConsume()).toBe(true);
  });
});

describe('ジョブの列', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('同時実行数までしか動かさず、残りは待ちになる', async () => {
    const q = new JobQueue(() => 2);
    let running = 0;
    let peak = 0;
    const ids = [1, 2, 3, 4, 5].map(
      (n) =>
        q.add({
          kind: 't',
          title: `job${n}`,
          run: async () => {
            running++;
            peak = Math.max(peak, running);
            await sleep(60);
            running--;
            return n;
          },
        }).id,
    );
    await sleep(10);
    expect(q.list().filter((j) => j.status === 'running')).toHaveLength(2);
    expect(q.list().filter((j) => j.status === 'queued')).toHaveLength(3);
    const done = await Promise.all(ids.map((id) => q.wait(id)));
    expect(peak).toBe(2);
    expect(done.map((j) => j.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(done.map((j) => j.result)).toEqual([1, 2, 3, 4, 5]);
    expect(done[0].startedAt && done[0].endedAt).toBeTruthy();
  });

  it('待ちの取り消しは実行されない。実行中の取り消しは止まる', async () => {
    const q = new JobQueue(() => 1);
    let secondRan = false;
    const first = q.add({
      kind: 't',
      title: 'first',
      run: (ctx) =>
        new Promise((_res, rej) => {
          ctx.signal.addEventListener('abort', () => rej(new ClaudeError('canceled', '')));
        }),
    });
    const second = q.add({
      kind: 't',
      title: 'second',
      run: async () => {
        secondRan = true;
      },
    });
    await sleep(10);
    expect(q.cancel(second.id)).toBe(true);
    expect(q.cancel(first.id)).toBe(true);
    expect((await q.wait(first.id)).status).toBe('canceled');
    expect((await q.wait(second.id)).status).toBe('canceled');
    expect(secondRan).toBe(false);
  });

  it('失敗の種類と進み具合が伝わる。変化はイベントで届く', async () => {
    const q = new JobQueue(() => 2);
    const seen: string[] = [];
    q.on('change', (j) => seen.push(`${j.title}:${j.status}:${j.progress}`));
    const a = q.add({
      kind: 't',
      title: 'a',
      run: async (ctx) => {
        ctx.progress('途中');
        throw new ClaudeError('usage_limit', 'resets 12:30am');
      },
    });
    const info = await q.wait(a.id);
    expect(info.status).toBe('failed');
    expect(info.error).toEqual({ kind: 'usage_limit', message: 'resets 12:30am' });
    expect(seen).toContain('a:running:途中');
    expect(seen.at(-1)).toBe('a:failed:途中');
  });

  it('偽 Claude のジョブを取り消すと、子プロセスが止まり「取り消し」になる', async () => {
    const dir = makeTmpDir();
    const fake = fakeClaude(dir, { default: 'slow', slowMs: 30000 });
    const q = new JobQueue(() => 2);
    const job = q.add({ kind: 'ping', title: '接続の確認', run: (ctx) => ping(dir, fake, { signal: ctx.signal }) });
    await sleep(500);
    q.cancel(job.id);
    const info = await q.wait(job.id);
    expect(info.status).toBe('canceled');
  });
});
