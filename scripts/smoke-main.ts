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
import { createTest, getVerify } from '../src/core/tests';
import { getUnits } from '../src/core/units';
import { addDays, todayString } from '../src/shared/dates';
import { leafUnits } from '../src/shared/subjects';

const MAX_CALLS = 5;
const fake = process.argv.includes('--fake');
const repoRoot = process.cwd();
const say = (s = '') => console.log(s);

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
  core.updateSettings({ dailyLimit: MAX_CALLS, timeoutMin: 10, concurrency: 1, model: process.env.ME_SMOKE_MODEL ?? 'sonnet' });
  say(`== smoke_real(${fake ? '偽 Claude' : '本物の Claude'}、呼び出しは ${MAX_CALLS} 回まで、モデル ${core.getSettings().model})==`);
  say(`作業フォルダ: ${dir}`);

  const warnings: string[] = [];
  const started = Date.now();
  const ctx: JobContext = { signal: new AbortController().signal, progress: (t) => say(`  … ${t}`) };
  let failure: string | null = null;
  let projectDir = '';
  try {
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
    failure = e instanceof Error ? e.message : String(e);
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
        say(`- ${r.kind}(${r.attempt} 回目): ${r.outcome}、${(r.durationMs / 1000).toFixed(1)} 秒${r.validationError ? `\n    出力の問題: ${String(r.validationError).slice(0, 300)}` : ''}${r.message ? `\n    失敗: ${String(r.message).slice(0, 300)}` : ''}`);
      } catch {
        say('- (読めない記録)');
      }
    }
  }
  say(`呼び出し回数: ${core.limiter.used()} / ${MAX_CALLS}、全体の所要時間: ${((Date.now() - started) / 1000).toFixed(0)} 秒`);
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
