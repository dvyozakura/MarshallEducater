// 本物の Claude を使う最小の通し確認(Tools/smoke_real.sh から、esbuild でまとめて実行される)。
// 小さなプロジェクトで「問題を2問作る → 検算 → ダミー答案を採点」まで。Claude の呼び出しは多くて5回(1日の上限の仕組みで止める)。
// --fake を付けると偽 Claude で同じ流れを通す(スクリプト自体の確認用。本物は呼ばない)。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { submitAnswers } from '../src/core/answers';
import { AppCore } from '../src/core/app';
import { getAnswerKey, gradeTest, gradingTotals } from '../src/core/grading';
import type { JobContext } from '../src/core/jobs';
import { createProject } from '../src/core/projects';
import { answerChat, postQuestion } from '../src/core/teach';
import { createTest, getVerify } from '../src/core/tests';
import { getChapter, getChapterReview, getTextbookView, textbookPaths } from '../src/core/textbook';
import { buildChapter } from '../src/core/textbook_build';
import { getUnits } from '../src/core/units';
import { addDays, todayString } from '../src/shared/dates';
import { ENGINE_LABEL, type EngineId } from '../src/shared/engines';
import { engineVersion } from '../src/core/engine_check';
import { ClaudeError } from '../src/core/claude/task';
import { leafUnits } from '../src/shared/subjects';
import { notationErrors } from '../src/shared/notation';

const MAX_CALLS = 5;
const fake = process.argv.includes('--fake');
/** --textbook: 教材の最小確認(1つの章を作る → 点検 → その章に1回質問)。 */
const textbookMode = process.argv.includes('--textbook');
/** --engines: ChatGPT・Gemini の最小確認(入っているエンジンごとに、問題を1問作る → Claude で検算 → 採点。1エンジンにつき呼び出し3回まで)。 */
const enginesMode = process.argv.includes('--engines');
const ENGINE_MAX_CALLS = 3;
/** --kokugo: 国語の最小確認(現代文1問・漢文1問を作る → 検算。呼び出し4回まで)。 */
const kokugoMode = process.argv.includes('--kokugo');
const repoRoot = process.cwd();
const say = (s = '') => console.log(s);
const DONE = Symbol('done');
const indent = (s: string) => `   ${s.replace(/\n/g, '\n   ')}`;
const mathCount = (s: string) => (s.match(/\$[^$]+\$/g) ?? []).length;

/**
 * 教材の最小確認: 第1章を小さな形(例題1題・選択式、確認問題なし)で作る → 点検(指摘があれば修正)→ その章に1回質問。
 * 呼び出し: 本文 1+問題づくり 1+解き直し 1+点検 1(+修正 0〜1)+質問 1 = 5〜6。上限の 5 回に達したら質問は飛ばす。
 */
async function textbookCheck(core: AppCore, projectId: string, sid: string, ctx: JobContext, warnings: string[]): Promise<void> {
  const view = getTextbookView(core, projectId, sid);
  const first = view.chapters[0];
  say(`2. 教材の第1章「${first.name}」を作ります(本文 → 例題1題の作成と検算 → 点検 → 指摘があれば修正。数分かかります)`);
  const r = await buildChapter(core, projectId, sid, first.unitId, ctx, {
    spec: { examples: [{ difficulty: 'easy', format: 'choice' }], quiz: [], chars: '800〜1500' },
  });
  const ch = getChapter(core, projectId, sid, first.unitId)!;
  const review = getChapterReview(core, projectId, sid, first.unitId)?.records.at(-1);
  say(`   版 ${r.chapterVersion}・例題 ${r.examples} 題・点検の指摘 ${r.issues} 件${r.revised ? '(直した)' : ''}・検算: 採用 ${r.verify.adopted}・作り直し ${r.verify.regenerated}・破棄 ${r.verify.discarded}`);
  for (const [name, text] of [['導入', ch.intro], ['要点', ch.points], ['よくある誤り', ch.pitfalls]] as const) {
    say(`   --- ${name}(${text.length} 字、数式 ${mathCount(text)} 個)`);
    say(indent(text.length > 900 ? `${text.slice(0, 900)}…(以下略)` : text));
    if (text.trim().length < 80) warnings.push(`章の「${name}」が短すぎます(${text.trim().length} 字)。`);
  }
  if (mathCount(ch.points) === 0) warnings.push('数学の章の「要点」に、数式($...$)が1つもありません。');
  if (ch.figures.length) say(`   図: ${ch.figures.length} 個(${ch.figures.map((f) => f.caption).join('、')})`);
  for (const e of ch.examples) {
    say(`   --- 例題(${e.difficulty}・${e.format})ねらい: ${e.focus}`);
    say(indent(e.body));
    e.choices.forEach((c, i) => say(`     (${i + 1}) ${c}`));
    say(`   解答: ${e.answer}`);
    say(indent(e.solution.slice(0, 600)));
  }
  if (review) {
    say(`   点検の所見: ${review.comment || '(なし)'}`);
    for (const i of review.issues) say(`   指摘(${i.section}): ${i.problem} → ${i.fix}`);
  }
  say(`   章のファイル: ${textbookPaths(core, projectId, sid).chapterMd(first.unitId)}`);

  if (core.limiter.used() >= MAX_CALLS) {
    warnings.push(`呼び出しが上限(${MAX_CALLS} 回)に達したので、章への質問は飛ばしました(点検の修正が入ったため)。`);
    return;
  }
  const quote = ch.points.split('\n').find((l) => l.trim().length > 15)?.trim().slice(0, 120) ?? null;
  say(`3. 章の一文を選んで質問します(選んだ箇所: 「${quote ?? 'なし'}」)`);
  const chat = postQuestion(core, projectId, sid, { context: { chapterUnitId: first.unitId }, question: 'この部分を、別の言い方と具体例で説明してください。', quote });
  const answered = await answerChat(core, projectId, sid, chat.id, ctx);
  const answer = answered.messages.at(-1)!.text;
  say(`   答え(${answer.length} 字、数式 ${mathCount(answer)} 個):`);
  say(indent(answer.length > 1200 ? `${answer.slice(0, 1200)}…(以下略)` : answer));
  if (answer.trim().length < 50) warnings.push('質問への答えが短すぎます。');
}

/**
 * ほかの教員エンジンの最小確認。入っていない・ログインしていないエンジンは飛ばして、その旨を出す。
 * 1エンジンあたり: 問題を1問作る(そのエンジン)→ 検算(Claude。別エンジン)→ 採点(そのエンジン)。選択式なので照らし合わせの呼び出しは無い。
 */
async function enginesCheck(core: AppCore, projectId: string, sid: string, unitId: string, ctx: JobContext, warnings: string[]): Promise<void> {
  let n = 2;
  for (const engine of ['codex', 'gemini'] as const satisfies readonly EngineId[]) {
    say(`${n++}. ${ENGINE_LABEL[engine]}`);
    const version = engineVersion(core, engine);
    if (version === null) {
      say('   未導入(コマンドが見つかりません)。飛ばします。');
      continue;
    }
    say(`   版: ${version}`);
    const s = core.getSettings();
    core.updateSettings({ defaultEngine: engine, engineRoles: { verify: 'claude' }, engines: { ...s.engines, [engine]: { ...s.engines[engine], dailyLimit: ENGINE_MAX_CALLS } } });
    const before = core.limiterFor(engine).used();
    try {
      const test = await createTest(
        core,
        projectId,
        sid,
        { kind: 'practice', title: `エンジン確認(${engine})`, timeLimitMin: 5, instructions: '', purpose: '動作確認のための小テスト(短く、計算の軽い問題)', requests: [{ unitId, difficulty: 'easy', format: 'choice', origin: 'practice' }] },
        ctx,
      );
      const key = getAnswerKey(core, projectId, sid, test.id);
      const v = getVerify(core, projectId, sid, test.id);
      const p = test.problems[0];
      say(`   作った問題(${test.madeBy?.engine ?? '?'}・検算 ${v?.verifiedBy?.engine ?? '?'}: 採用 ${v?.counts.adopted}・作り直し ${v?.counts.regenerated}・破棄 ${v?.counts.discarded})`);
      say(indent(p.body));
      p.choices.forEach((c, i) => say(`     (${i + 1}) ${c}`));
      const answer = key.items[0]?.answer ?? '';
      say(`   正解: ${answer}`);
      submitAnswers(core, projectId, sid, test.id, { answers: { [p.id]: answer }, elapsedSec: 60 });
      const g = await gradeTest(core, projectId, sid, test.id, ctx);
      say(`   採点(${g.madeBy?.engine ?? '?'}): ${g.items[0].score} / ${g.items[0].max} 点 根拠: ${g.items[0].rationale}`);
      if (g.items[0].score < g.items[0].max) warnings.push(`${engine}: 正解をそのまま書いた答案が満点になりませんでした。`);
      if (test.madeBy?.engine !== engine || g.madeBy?.engine !== engine) warnings.push(`${engine}: 作成・採点のエンジンの記録が想定と違います。`);
    } catch (e) {
      const kind = e instanceof ClaudeError ? e.kind : 'other';
      if (kind === 'not_logged_in' || kind === 'not_found' || kind === 'usage_limit') say(`   ${kind === 'not_logged_in' ? '未ログイン' : kind === 'usage_limit' ? '使用量の上限' : '起動できません'}のため飛ばします: ${(e as Error).message.slice(0, 300)}`);
      else warnings.push(`${engine}: 失敗 — ${(e as Error).message.slice(0, 300)}`);
    }
    say(`   呼び出し: ${engine} ${core.limiterFor(engine).used() - before} 回`);
  }
  core.updateSettings({ defaultEngine: 'claude', engineRoles: {} });
}

/**
 * 国語の最小確認: 現代文1問・漢文1問(どちらも選択式)を作る → 検算。呼び出しは 2+2 = 4 回。
 * 出てきた記法を調べ(壊れていないか・使っているか)、本文をそのまま出す。画面での確認は tests/e2e/99-view-smoke.spec.ts。
 */
async function kokugoCheck(core: AppCore, ctx: JobContext, warnings: string[], onProject: (dir: string) => void): Promise<string> {
  const project = createProject(core, {
    name: 'スモーク大学 文学部',
    university: 'スモーク大学',
    faculty: '文学部',
    examDate: addDays(todayString(), 100),
    examType: 'kokkoritsu',
    targetLevel: 'solid',
    dailyMinutes: 60,
    subjectNames: ['現代文', '漢文'],
  });
  onProject(core.projectDir(project.id));
  say(`1. プロジェクトを作成: ${project.name}(科目 ${project.subjects.map((s) => `${s.name}=${s.writingMode}`).join('、')})`);
  let n = 2;
  for (const s of project.subjects) {
    const units = leafUnits(getUnits(core, project.id, s.id).tree);
    const unit = s.name === '漢文' ? (units.find((u) => u.name.includes('返り点')) ?? units[0]) : (units.find((u) => u.name.includes('傍線部')) ?? units[0]);
    say(`${n++}. ${s.name}: 「${unit.fullName}」の選択式を1問作り、検算します`);
    const test = await createTest(
      core,
      project.id,
      s.id,
      {
        kind: 'practice',
        title: `国語の確認(${s.name})`,
        timeLimitMin: 10,
        instructions: '',
        purpose: s.name === '漢文' ? '動作確認: 短い訓読文(返り点・送り仮名つき)を読ませる問題' : '動作確認: 短い自作の文章に傍線部を付けて問う問題',
        requests: [{ unitId: unit.id, difficulty: 'easy', format: 'choice', origin: 'practice' }],
      },
      ctx,
    );
    const v = getVerify(core, project.id, s.id, test.id);
    const key = getAnswerKey(core, project.id, s.id, test.id);
    say(`   検算: 採用 ${v?.counts.adopted}・作り直し ${v?.counts.regenerated}・破棄 ${v?.counts.discarded}`);
    for (const p of test.problems) {
      say(indent(p.body));
      p.choices.forEach((c, i) => say(`     (${i + 1}) ${c}`));
      say(`   正解: ${key.items.find((k) => k.problemId === p.id)?.answer}`);
      const errs = [p.body, ...p.choices].flatMap((t) => notationErrors(t));
      if (errs.length) warnings.push(`${s.name}: 記法の誤り ${errs.join(' / ')}`);
      const used = ['{{傍線', '{{空欄', '{{傍点', '{{段落', ':::漢文', '[^', '[_', '|'].filter((k) => p.body.includes(k));
      say(`   使われた記法: ${used.join(' ') || '(なし)'}`);
      if (s.name === '漢文' && !p.body.includes(':::漢文')) warnings.push('漢文の問題に「:::漢文」の区切りがありません。');
      if (s.name === '現代文' && !/\{\{(傍線|波線|二重傍線|空欄)/.test(p.body)) warnings.push('現代文の問題に、傍線・空欄の記法がありません。');
    }
    if (test.problems.length === 0) warnings.push(`${s.name}: 問題が検算で落ちて残りませんでした。`);
  }
  return core.projectDir(project.id);
}

async function main(): Promise<number> {
  const base = resolve(repoRoot, 'tests', 'tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, fake ? 'smoke-fake-' : 'smoke-real-'));
  process.env.ME_PROMPTS_DIR = resolve(repoRoot, 'src', 'prompts');
  const extraEnv: Record<string, string> = {};
  if (fake) {
    process.env.ME_FAKE_CLAUDE = '1';
    extraEnv.ME_FAKE_CLAUDE = '1';
    extraEnv.ME_FAKE_CLAUDE_PATH = resolve(repoRoot, 'Tools', 'fake-claude', 'fake-claude.mjs');
  } else {
    delete process.env.ME_FAKE_CLAUDE;
  }
  const core = new AppCore({ userDataDir: join(dir, 'userData'), defaultDataDir: join(dir, 'data'), envDataDir: join(dir, 'data'), extraEnv });
  core.updateSettings({ dailyLimit: kokugoMode ? 4 : MAX_CALLS, timeoutMin: 10, concurrency: 1, model: process.env.ME_SMOKE_MODEL ?? 'sonnet' });
  say(`== smoke_real(${fake ? '偽 Claude' : '本物の Claude'}、呼び出しは ${kokugoMode ? 4 : MAX_CALLS} 回まで、モデル ${core.getSettings().model})==`);
  say(`作業フォルダ: ${dir}`);

  const warnings: string[] = [];
  const started = Date.now();
  const ctx: JobContext = { signal: new AbortController().signal, progress: (t) => say(`  … ${t}`) };
  let failure: string | null = null;
  let projectDir = '';
  try {
    if (kokugoMode) {
      projectDir = await kokugoCheck(core, ctx, warnings, (d) => (projectDir = d));
      throw DONE;
    }
    // 1. 小さなプロジェクト
    const project = createProject(core, {
      name: 'スモーク大学 理学部',
      university: 'スモーク大学',
      faculty: '理学部',
      examDate: addDays(todayString(), 100),
      examType: 'kokkoritsu',
      targetLevel: 'solid',
      dailyMinutes: 60,
      subjectNames: ['数学II・B・C'],
    });
    projectDir = core.projectDir(project.id);
    const sid = project.subjects[0].id;
    const units = leafUnits(getUnits(core, project.id, sid).tree);
    say(`1. プロジェクトを作成: ${project.name}(科目 ${project.subjects[0].name}、単元 ${units.length})`);

    if (textbookMode) {
      await textbookCheck(core, project.id, sid, ctx, warnings);
      throw DONE;
    }
    if (enginesMode) {
      await enginesCheck(core, project.id, sid, units[0].id, ctx, warnings);
      throw DONE;
    }

    // 2. 問題を2問作る → 検算(別の呼び出しで解き直し)
    say('2. 問題を2問作り、検算します(数分かかります)');
    const test = await createTest(
      core,
      project.id,
      sid,
      {
        kind: 'daily',
        title: 'スモークテスト',
        timeLimitMin: 10,
        instructions: '',
        purpose: '動作確認のための小テスト(短く、計算の軽い問題)',
        requests: [
          { unitId: units[0].id, difficulty: 'easy', format: 'choice', origin: 'practice' },
          { unitId: units[1].id, difficulty: 'easy', format: 'short', origin: 'practice' },
        ],
        date: todayString(),
      },
      ctx,
    );
    const verify = getVerify(core, project.id, sid, test.id);
    const key = getAnswerKey(core, project.id, sid, test.id);
    say(`   できた問題: ${test.problems.length} 問 / 検算: 採用 ${verify?.counts.adopted}・作り直し ${verify?.counts.regenerated}・破棄 ${verify?.counts.discarded}`);
    for (const p of test.problems) {
      say(`   --- ${p.number}(${p.unitName}・${p.format}・${p.points} 点)`);
      say(`   ${p.body.replace(/\n/g, '\n   ')}`);
      p.choices.forEach((c, i) => say(`     (${i + 1}) ${c}`));
      say(`   正解: ${key.items.find((k) => k.problemId === p.id)?.answer}`);
    }
    if (test.problems.length < 2) warnings.push(`問題が ${test.problems.length} 問しか残りませんでした(検算で落ちた)。`);

    // 3. ダミー答案: 1問目は正解をそのまま、2問目はわざと誤答
    const answers: Record<string, string> = {};
    test.problems.forEach((p, i) => {
      answers[p.id] = i === 0 ? (key.items.find((k) => k.problemId === p.id)?.answer ?? '') : '分かりませんでした。たぶん 0 です。';
    });
    submitAnswers(core, project.id, sid, test.id, { answers, elapsedSec: 300 });
    say('3. ダミー答案を提出(1問目は正解、2問目はわざと誤答)→ 採点します');
    const grading = await gradeTest(core, project.id, sid, test.id, ctx);
    const totals = gradingTotals(grading);
    say(`   採点: ${totals.score} / ${totals.max} 点`);
    grading.items.forEach((g, i) => {
      say(`   --- ${test.problems[i].number}: ${g.score} / ${g.max} 点 ミスの種類: ${g.mistake ?? 'なし'}`);
      say(`   根拠: ${g.rationale}`);
      if (g.comment) say(`   所見: ${g.comment}`);
    });
    if (grading.items[0].score < grading.items[0].max) warnings.push('正解をそのまま書いた1問目が、満点になりませんでした(採点か、正解の書き方を確認)。');
    if (grading.items[1] && grading.items[1].score >= grading.items[1].max) warnings.push('わざと誤答にした2問目が、満点になりました。');
    if (grading.items[1] && grading.items[1].score < grading.items[1].max && !grading.items[1].mistake) warnings.push('減点のある2問目に、ミスの種類が付いていません。');
  } catch (e) {
    if (e !== DONE) failure = e instanceof Error ? e.message : String(e);
  }

  // 呼び出しの記録(logs/)から、回数と所要時間をまとめる
  say('');
  say('== Claude の呼び出しの記録 ==');
  const logsDir = join(projectDir, 'logs');
  if (projectDir && existsSync(logsDir)) {
    const records = readdirSync(logsDir).map((name) => {
      try {
        return JSON.parse(readFileSync(join(logsDir, name), 'utf8')) as Record<string, unknown> & { startedAt: string; durationMs: number };
      } catch {
        return null;
      }
    });
    for (const r of records.filter((x) => x !== null).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))) {
      try {
        say(`- ${r.engine ?? 'claude'} ${r.kind}(${r.attempt} 回目): ${r.outcome}、${(r.durationMs / 1000).toFixed(1)} 秒${r.validationError ? `\n    出力の問題: ${String(r.validationError).slice(0, 300)}` : ''}${r.message ? `\n    失敗: ${String(r.message).slice(0, 300)}` : ''}`);
      } catch {
        say('- (読めない記録)');
      }
    }
  }
  if (enginesMode) say(`ほかのエンジンの呼び出し: codex ${core.limiterFor('codex').used()}、gemini ${core.limiterFor('gemini').used()}(各 ${ENGINE_MAX_CALLS} 回まで)`);
  say(`呼び出し回数: ${core.limiter.used()} / ${kokugoMode ? 4 : MAX_CALLS}、全体の所要時間: ${((Date.now() - started) / 1000).toFixed(0)} 秒`);
  for (const w of warnings) say(`注意: ${w}`);
  if (failure) {
    say(`smoke_real: 失敗 — ${failure}`);
    return 1;
  }
  say(warnings.length ? 'smoke_real: 通りました(注意あり)' : 'smoke_real: OK');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('smoke_real: 内部エラー', e);
    process.exit(2);
  },
);
