// 教員エンジン(Claude・ChatGPT・Gemini)の切り替え・役割ごとの割り当て・別 AI での検算・未導入/未ログインの案内。すべて偽エンジンで行う。
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { codexArgs, extractJsonText, geminiArgs, parseGeminiJson, resolveNpmShim } from '../../src/core/claude/engines';
import { buildPrompt } from '../../src/core/claude/prompts';
import { callClaude, ClaudeError, collectImages } from '../../src/core/claude/task';
import { generateVerified } from '../../src/core/generate';
import { getQuality } from '../../src/core/quality';
import { getChat } from '../../src/core/teach';
import { getTest, getVerify, listTests } from '../../src/core/tests';
import { ENGINE_CAPS, engineAllowedForRole, resolveEngine, roleOfKind, type ResolveInput } from '../../src/shared/engines';
import { classifyFailureText, failureGuide, failureTitle } from '../../src/shared/failures';
import type { JobInfo } from '../../src/shared/jobs';
import { PingOutputSchema } from '../../src/shared/schema';
import { importFake, makeCore, makeTmpDir, sampleInput, testCtx, type TestCore } from './helpers';

const PingSchema = z.object({ ok: z.literal(true), message: z.string() });

async function done(t: TestCore, job: JobInfo): Promise<JobInfo> {
  const info = await t.core.jobs.wait(job.id);
  if (info.status !== 'done') throw new Error(`ジョブ ${job.kind} が ${info.status}: ${JSON.stringify(info.error)}`);
  return info;
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

function setup(control: unknown = {}) {
  const t = makeCore(control);
  const p = t.api.createProject(sampleInput);
  const sid = p.subjects[0].id;
  const engines = () => t.fake.calls().map((c) => `${(c as { engine?: string }).engine ?? 'claude'}:${c.kind}`);
  return { t, p, sid, engines };
}

const base = (o: Partial<ResolveInput['app']> = {}, project: ResolveInput['project'] = null, available: ResolveInput['available'] = []): ResolveInput => ({
  app: { defaultEngine: 'claude', roles: {}, verifyWithOther: false, ...o },
  project,
  available,
});

describe('割り当ての決め方(アプリ全体 → プロジェクト → 役割)', () => {
  it('既定は全部 Claude。既定のエンジン、役割ごと、プロジェクトの上書きの順に効く', () => {
    expect(resolveEngine('create', base()).engine).toBe('claude');
    expect(resolveEngine('grade', base({ defaultEngine: 'codex' })).engine).toBe('codex');
    expect(resolveEngine('grade', base({ defaultEngine: 'codex', roles: { grade: 'gemini' } })).engine).toBe('gemini');
    // プロジェクトの上書き: 既定のエンジンだけ変える → 役割ごとのアプリ設定は残る
    const proj = { defaultEngine: 'gemini' as const, roles: {}, verifyWithOther: null };
    expect(resolveEngine('create', base({ roles: { grade: 'codex' } }, proj)).engine).toBe('gemini');
    expect(resolveEngine('grade', base({ roles: { grade: 'codex' } }, proj)).engine).toBe('codex');
    // プロジェクトの役割ごとが最優先
    expect(resolveEngine('grade', base({ roles: { grade: 'codex' } }, { defaultEngine: null, roles: { grade: 'claude' }, verifyWithOther: null })).engine).toBe('claude');
  });

  it('検算を別の AI に: つながっているほかのエンジンを使う。無ければ同じエンジン(sameAsCreate)', () => {
    const r1 = resolveEngine('verify', base({ verifyWithOther: true }, null, ['gemini']));
    expect(r1.engine).toBe('gemini');
    expect(r1.note).toContain('別の AI');
    const r2 = resolveEngine('verify', base({ verifyWithOther: true }));
    expect(r2.engine).toBe('claude');
    expect(r2.sameAsCreate).toBe(true);
    // 問題作成が ChatGPT なら、Claude(常に使える扱い)で検算する
    expect(resolveEngine('verify', base({ verifyWithOther: true, defaultEngine: 'codex' })).engine).toBe('claude');
    // 検算を明示的に別のエンジンにしていれば、そのまま
    expect(resolveEngine('verify', base({ verifyWithOther: true, roles: { verify: 'codex' } })).engine).toBe('codex');
    // プロジェクトで「しない」にできる
    expect(resolveEngine('verify', base({ verifyWithOther: true }, { defaultEngine: null, roles: {}, verifyWithOther: false }, ['gemini'])).engine).toBe('claude');
  });

  it('プロンプトの種類 → 役割。画像を読めないエンジンは読み取りに割り当てられない', () => {
    expect(roleOfKind('generate_problems')).toBe('create');
    expect(roleOfKind('solve_problems')).toBe('verify');
    expect(roleOfKind('judge_answers')).toBe('verify');
    expect(roleOfKind('read_pages')).toBe('read');
    expect(roleOfKind('grade')).toBe('grade');
    expect(roleOfKind('chapter_body')).toBe('textbook');
    expect(roleOfKind('chat')).toBe('chat');
    // 画像を読めないエンジンを仮に作って確かめる
    const saved = ENGINE_CAPS.gemini.images;
    ENGINE_CAPS.gemini.images = false;
    try {
      expect(engineAllowedForRole('gemini', 'read')).toBe(false);
      expect(engineAllowedForRole('gemini', 'grade')).toBe(true);
      const r = resolveEngine('read', base({ roles: { read: 'gemini' } }));
      expect(r.engine).toBe('claude');
      expect(r.note).toContain('画像を読めない');
    } finally {
      ENGINE_CAPS.gemini.images = saved;
    }
  });
});

describe('エンジンごとの呼び方', () => {
  it('Codex: 読み取り専用+シェルなし、プロンプトは標準入力、画像は -i、最後の返答は -o', () => {
    const a = codexArgs({ cwd: 'C:/p', model: 'gpt-x', images: ['C:/p/a.png'], lastMessageFile: 'C:/p/last.txt' });
    expect(a[0]).toBe('exec');
    expect(a.join(' ')).toContain('-s read-only');
    expect(a.join(' ')).toContain('features.shell_tool=false');
    expect(a.join(' ')).toContain('-o C:/p/last.txt');
    expect(a.join(' ')).toContain('-m gpt-x');
    expect(a.join(' ')).toContain('-i C:/p/a.png');
    expect(a.at(-1)).toBe('-');
    expect(a).not.toContain('danger-full-access');
  });

  it('Gemini: JSON で出力、承認モード default(書き込み・コマンドは非対話では拒否)', () => {
    const a = geminiArgs({ model: '' });
    expect(a.join(' ')).toContain('--output-format json');
    expect(a.join(' ')).toContain('--approval-mode default');
    expect(a).not.toContain('--yolo');
    expect(a).not.toContain('yolo');
    expect(parseGeminiJson('{"response":"{\\"a\\":1}","stats":{}}')?.response).toBe('{"a":1}');
    expect(parseGeminiJson('{"error":{"type":"ApiError","code":429,"message":"quota"}}')?.error).toContain('429');
  });

  it('返答から JSON を取り出す(コードブロック・前後の文があっても)', () => {
    expect(extractJsonText('{"a":1}')).toBe('{"a":1}');
    expect(extractJsonText('結果です。\n```json\n{"a":1}\n```\n以上')).toBe('{"a":1}');
    expect(extractJsonText('はい: {"a":{"b":2}} です')).toBe('{"a":{"b":2}}');
    expect(extractJsonText('完了しました。')).toBeNull();
  });

  it('入力をプロンプトに埋め込む形(ChatGPT・Gemini)', () => {
    const text = buildPrompt({ kind: 'ping', vars: { note: '' }, inputFile: null, outputFile: 'x', schema: PingOutputSchema, inline: { input: { hello: 'こんにちは' }, images: ['C:/p/a.png'] } });
    expect(text).toContain('ME_PROMPT_KIND: ping');
    expect(text).toContain('<<<ME_INPUT_JSON');
    expect(text).toContain('こんにちは');
    expect(text).toContain('C:/p/a.png');
    expect(text).toContain('コマンドの実行もしません');
  });

  it('npm の起動用ファイル(.cmd)から本体の .js を見つける', async () => {
    const dir = makeTmpDir('shim-');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    mkdirSync(join(dir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '');
    writeFileSync(join(dir, 'codex.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    expect(resolveNpmShim(join(dir, 'codex.cmd'))).toBe(join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  });

  it('入力の中の画像を集める(読み取り)', async () => {
    const { t, p, sid } = setup();
    const src = importFake(t, p.id, sid, 2);
    const dir = t.core.projectDir(p.id);
    const sp = t.core.paths(p.id).subject(sid).source(src);
    const imgs = collectImages({ pages: [{ image: sp.pageRel(1) }, { image: sp.pageRel(2) }, { image: 'no/such.png' }] }, dir);
    expect(imgs).toHaveLength(2);
    expect(imgs.every((x) => existsSync(x))).toBe(true);
  });
});

describe('失敗の見分け(エンジンごと)', () => {
  it('Codex・Gemini の未ログイン・使用量上限の文言', () => {
    expect(classifyFailureText('ERROR: You’ve hit your usage limit. Try again later.', 'codex')).toBe('usage_limit');
    expect(classifyFailureText('Your workspace is out of credits. Add credits to continue.', 'codex')).toBe('usage_limit');
    expect(classifyFailureText('ERROR: unexpected status 401 Unauthorized', 'codex')).toBe('not_logged_in');
    expect(classifyFailureText('gemini: authentication failed (exit 41)', 'gemini')).toBe('not_logged_in');
    expect(classifyFailureText('ApiError 429 RESOURCE_EXHAUSTED: You exceeded your current quota', 'gemini')).toBe('usage_limit');
    expect(failureTitle('not_logged_in', 'codex')).toContain('ChatGPT');
    expect(failureGuide('not_logged_in', 'codex')).toContain('codex login');
    expect(failureTitle('not_found', 'gemini')).toContain('Gemini');
    expect(failureGuide('not_logged_in')).toContain('/login');
    expect(failureTitle('timeout', 'codex')).toBe('時間切れになりました');
    expect(failureTitle('invalid_output', 'gemini')).toContain('Gemini');
  });
});

describe('偽エンジンでの呼び出し', () => {
  it('既定のエンジンを ChatGPT にすると、Codex CLI の形で呼び、作ったエンジンを返す', async () => {
    const { t, p, engines } = setup();
    t.core.updateSettings({ defaultEngine: 'codex', engines: { ...t.core.getSettings().engines, codex: { path: '', model: 'gpt-test', dailyLimit: 200 } } });
    const r = await callClaude({ projectDir: t.core.projectDir(p.id), kind: 'ping', vars: { note: '' }, input: { x: 1 }, schema: PingSchema, env: t.core.claudeEnv() });
    expect(r.data.ok).toBe(true);
    expect(r.madeBy).toEqual({ engine: 'codex', model: 'gpt-test' });
    expect(engines()).toEqual(['codex:ping']);
    const call = t.fake.calls()[0];
    expect(call.argv).toContain('exec');
    expect(call.argv).toContain('read-only');
    expect(call.prompt).toContain('<<<ME_INPUT_JSON');
    // 記録に、どのエンジンで呼んだかが残る
    const logs = (await import('node:fs')).readdirSync(t.core.paths(p.id).logsDir).filter((n) => n.includes('_ping_'));
    const log = JSON.parse(readFileSync(`${t.core.paths(p.id).logsDir}/${logs[0]}`, 'utf8'));
    expect(log.engine).toBe('codex');
    expect(log.model).toBe('gpt-test');
  });

  it('Gemini: コードブロックつきの返答でも取り出せる。壊れた JSON はエラー内容を添えてやり直す', async () => {
    const { t, p, engines } = setup({ fenceReply: true, kinds: { ping: ['broken', 'ok'] } });
    t.core.updateSettings({ defaultEngine: 'gemini' });
    const r = await callClaude({ projectDir: t.core.projectDir(p.id), kind: 'ping', vars: { note: '' }, schema: PingSchema, env: t.core.claudeEnv() });
    expect(r.attempts).toBe(2);
    expect(r.madeBy.engine).toBe('gemini');
    expect(engines()).toEqual(['gemini:ping', 'gemini:ping']);
    expect(t.fake.calls()[1].prompt).toContain('JSON として読めません');
    expect(t.fake.calls()[1].prompt).toContain('最後の返答として JSON だけ');
  });

  it('入っていない・未ログイン・使用量の上限を、エンジンごとに見分けて案内する', async () => {
    const { t, p } = setup({ notFoundEngines: ['codex'] });
    const call = (engine: 'codex' | 'gemini') => callClaude({ projectDir: t.core.projectDir(p.id), kind: 'ping', vars: { note: '' }, schema: PingSchema, env: t.core.claudeEnv(), engine });
    const e1 = await expectFailure(call('codex'), 'not_found');
    expect(e1.engine).toBe('codex');
    expect(e1.message).toContain('ChatGPT');
    t.fake.set({ engineModes: { codex: 'not_logged_in', gemini: 'not_logged_in' } });
    expect((await expectFailure(call('codex'), 'not_logged_in')).engine).toBe('codex');
    expect((await expectFailure(call('gemini'), 'not_logged_in')).engine).toBe('gemini');
    t.fake.set({ engineModes: { codex: 'usage_limit', gemini: 'usage_limit' } });
    await expectFailure(call('codex'), 'usage_limit');
    await expectFailure(call('gemini'), 'usage_limit');
    // Claude はそのまま使える(ほかのエンジンが使えなくても)
    const ok = await callClaude({ projectDir: t.core.projectDir(p.id), kind: 'ping', vars: { note: '' }, schema: PingSchema, env: t.core.claudeEnv() });
    expect(ok.madeBy.engine).toBe('claude');
  });

  it('1日の上限はエンジンごとに数える', async () => {
    const { t, p } = setup();
    t.core.updateSettings({ engines: { ...t.core.getSettings().engines, codex: { path: '', model: '', dailyLimit: 1 } } });
    const call = (engine?: 'codex') => callClaude({ projectDir: t.core.projectDir(p.id), kind: 'ping', vars: { note: '' }, schema: PingSchema, env: t.core.claudeEnv(), engine });
    await call('codex');
    const e = await expectFailure(call('codex'), 'daily_limit');
    expect(e.message).toContain('ChatGPT');
    await call(); // Claude は別に数える
    expect(t.core.limiterFor('codex').used()).toBe(1);
    expect(t.core.limiterFor('claude').used()).toBe(1);
    expect(t.api.engineUsage().find((u) => u.engine === 'codex')).toEqual({ engine: 'codex', used: 1, limit: 1 });
  });

  it('接続の確認: 結果を設定に残し、つながったエンジンは検算の代わりに使える', async () => {
    const { t } = setup({ notFoundEngines: ['gemini'] });
    const ok = await t.core.jobs.wait(t.api.startPing('codex').id);
    expect(ok.status).toBe('done');
    const ng = await t.core.jobs.wait(t.api.startPing('gemini').id);
    expect(ng.status).toBe('failed');
    expect(ng.error?.kind).toBe('not_found');
    expect(ng.error?.engine).toBe('gemini');
    const st = t.core.getSettings().engineStatus;
    expect(st.find((s) => s.engine === 'codex')?.status).toBe('ok');
    expect(st.find((s) => s.engine === 'codex')?.version).toContain('fake-codex');
    expect(st.find((s) => s.engine === 'gemini')?.status).toBe('not_found');
    expect(t.core.availableEngines()).toEqual(['codex']);
    const info = t.api.engineInfo(null);
    expect(info.engines.map((e) => e.status.status)).toEqual(['unchecked', 'ok', 'not_found']);
  });

  it('検算を別の AI に: 問題作成は Claude、解き直しは ChatGPT。テストと検算の記録に両方が残る', async () => {
    const { t, p, sid, engines } = setup();
    t.core.updateSettings({ verifyWithOther: true, engineStatus: [{ engine: 'codex', status: 'ok', version: '0', message: '', checkedAt: null }] });
    const res = await generateVerified(
      t.core,
      { projectId: p.id, subjectId: sid, purpose: '演習', requests: [{ unitId: 'u01-01', difficulty: 'easy', format: 'choice', origin: 'practice' }, { unitId: 'u01-02', difficulty: 'standard', format: 'essay', origin: 'practice' }] },
      testCtx(),
    );
    expect(res.madeBy?.engine).toBe('claude');
    expect(res.verifiedBy?.engine).toBe('codex');
    expect(engines()).toContain('claude:generate_problems');
    expect(engines()).toContain('codex:solve_problems');
    expect(engines()).toContain('codex:judge_answers');
    expect(engines()).not.toContain('claude:solve_problems');
    // 解き直しのプロンプトに、答えは入っていない(埋め込みの入力でも)
    const solve = t.fake.calls().find((c) => c.kind === 'solve_problems')!;
    expect(solve.prompt).not.toContain('"rubric"');
  });

  it('役割ごとの割り当てとプロジェクトの上書き: 採点だけ Gemini、テストの記録・品質の欄にエンジンが出る', async () => {
    const { t, p, sid, engines } = setup();
    await done(t, t.api.startCreateDiagnostic(p.id, sid));
    const test = listTests(t.core, p.id, sid)[0];
    expect(getTest(t.core, p.id, sid, test.id).madeBy?.engine).toBe('claude');
    expect(getVerify(t.core, p.id, sid, test.id)?.verifiedBy?.engine).toBe('claude');
    // このプロジェクトだけ、採点を Gemini に
    t.api.setProjectEngines(p.id, { defaultEngine: null, roles: { grade: 'gemini' }, verifyWithOther: null });
    expect(t.api.engineInfo(p.id).resolved.find((r) => r.role === 'grade')?.engine).toBe('gemini');
    expect(t.api.engineInfo(null).resolved.find((r) => r.role === 'grade')?.engine).toBe('claude');
    const full = getTest(t.core, p.id, sid, test.id);
    t.api.submitAnswers(p.id, sid, test.id, { answers: Object.fromEntries(full.problems.map((q) => [q.id, '1'])), elapsedSec: 60 });
    await done(t, t.api.startGrade(p.id, sid, test.id));
    expect(engines()).toContain('gemini:grade');
    const g = t.api.getResultView(p.id, sid, test.id).grading!;
    expect(g.madeBy?.engine).toBe('gemini');
    const q = getQuality(t.core);
    expect(q.byEngine.map((e) => e.engine).sort()).toEqual(['claude', 'gemini']);
    expect(q.byEngine.find((e) => e.engine === 'gemini')!.quality.grading.items).toBe(full.problems.length);
    expect(q.byEngine.find((e) => e.engine === 'claude')!.quality.grading.items).toBe(0);
    expect(q.byEngine.find((e) => e.engine === 'claude')!.quality.verify.total).toBeGreaterThan(0);
    // 上書きを消すと、アプリ全体の設定に戻る
    t.api.setProjectEngines(p.id, null);
    expect(t.api.engineInfo(p.id).resolved.find((r) => r.role === 'grade')?.engine).toBe('claude');
  });

  it('読み取りを ChatGPT に: ページ画像を -i で添付する', async () => {
    const { t, p, sid } = setup();
    t.core.updateSettings({ engineRoles: { read: 'codex' } });
    const src = importFake(t, p.id, sid, 2);
    await done(t, t.api.startReadSource(p.id, sid, src));
    const call = t.fake.calls().find((c) => c.kind === 'read_pages')!;
    expect((call as { engine?: string }).engine).toBe('codex');
    expect(call.argv.filter((a) => a === '-i')).toHaveLength(2);
    expect(t.api.getExtracted(p.id, sid, src)?.madeBy?.engine).toBe('codex');
  });

  it('会話の続きができないエンジン: --resume を使わず、これまでのやりとりを入力に入れる', async () => {
    const { t, p, sid } = setup();
    t.core.updateSettings({ engineRoles: { chat: 'gemini' } });
    const q1 = t.api.askQuestion(p.id, sid, { question: '漸化式がわかりません' });
    await done(t, q1.job);
    await done(t, t.api.askQuestion(p.id, sid, { chatId: q1.chatId, question: 'もう少し詳しく' }).job);
    const chats = t.fake.calls().filter((c) => c.kind === 'chat');
    expect(chats).toHaveLength(2);
    expect(chats[1].argv).not.toContain('--resume');
    expect(chats[1].prompt).toContain('漸化式がわかりません'); // 前のやりとりが入力に入っている
    const chat = getChat(t.core, p.id, sid, q1.chatId);
    expect(chat.messages.filter((m) => m.role === 'assistant').every((m) => m.madeBy?.engine === 'gemini')).toBe(true);
  });

  it('既定の設定(Claude のみ)では、今までと同じ形で呼ぶ', async () => {
    const { t, p, engines } = setup();
    await callClaude({ projectDir: t.core.projectDir(p.id), kind: 'ping', vars: { note: '' }, schema: PingSchema, env: t.core.claudeEnv() });
    expect(engines()).toEqual(['claude:ping']);
    expect(t.fake.calls()[0].argv).toContain('-p');
    expect(t.fake.calls()[0].prompt).toContain('ME_OUTPUT_FILE: .me/io/');
    // プロジェクトのフォルダに、ほかのエンジン向けの設定も置く(Gemini はシェル・書き込みのツールを外す)
    const g = JSON.parse(readFileSync(`${t.core.projectDir(p.id)}/.gemini/settings.json`, 'utf8'));
    expect(g.tools.exclude).toContain('run_shell_command');
    expect(existsSync(`${t.core.projectDir(p.id)}/AGENTS.md`)).toBe(true);
  });
});
