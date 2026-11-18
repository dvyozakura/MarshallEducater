// 共通の「問題を作る」仕組みと、検算(別の呼び出しで、解答を見せずに解かせて照らし合わせる)。
import { existsSync } from 'node:fs';
import { isUsableSvg } from '../shared/mdmath';
import {
  GenerateOutputSchema,
  JudgeOutputSchema,
  MISTAKE_LABEL,
  PROBLEM_ORIGIN_LABEL,
  SolveOutputSchema,
  type Difficulty,
  type GeneratedProblem,
  type MistakeType,
  type ProblemFormat,
  type ProblemOrigin,
  type VerifyOutcome,
} from '../shared/schema';
import type { AppCore } from './app';
import { callClaude } from './claude/task';
import type { JobContext } from './jobs';
import { getProject, getSubject } from './projects';
import { Files, readData } from './store';
import { getUnits, projectBrief, unitNameMap } from './units';

/** 1問ぶんの注文。 */
export interface ProblemRequest {
  unitId: string;
  difficulty: Difficulty;
  format: ProblemFormat;
  origin: ProblemOrigin;
  /** この単元でよくするミス(苦手克服問題)。 */
  mistake?: MistakeType | null;
  /** 前に間違えた問題(復習の類題のもと)。 */
  reference?: string | null;
  /** 復習のとき: もとの問題。 */
  reviewOf?: { testId: string; problemId: string } | null;
}

export interface GenerateArgs {
  projectId: string;
  subjectId: string;
  /** 用途(プロンプトに入れる。例: 実力診断テスト)。 */
  purpose: string;
  requests: ProblemRequest[];
}

export interface VerifiedProblem {
  request: ProblemRequest;
  unitName: string;
  problem: GeneratedProblem;
}

/** 検算の記録(1件 = 1回の判定の結末)。 */
export interface VerifyEvent {
  /** 何番目の注文か(0始まり)。 */
  slot: number;
  unitId: string;
  outcome: VerifyOutcome;
  reason: string;
}

export interface GenerateResult {
  /** 採用した問題(注文の順)。破棄されて埋まらなかった注文は含まない。 */
  problems: Array<VerifiedProblem & { slot: number }>;
  events: VerifyEvent[];
  counts: Record<VerifyOutcome, number>;
}

/** 答えの見た目の違い(空白、全角・半角、$ 記号、文末の句点)をならす。 */
export function normalizeAnswer(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/\\[,;! ]|\\left|\\right|\\displaystyle/g, '')
    .replace(/[\s$]/g, '')
    .replace(/[。.]$/, '')
    .toLowerCase();
}

/** 選択式の答えから、選択肢の番号を取り出す。 */
export function choiceNumber(s: string): number | null {
  const m = s.normalize('NFKC').match(/\d+/);
  return m ? Number(m[0]) : null;
}

/** 作った問題そのものの検査(型は合っているが中身がおかしいもの)。 */
export function checkGenerated(problems: GeneratedProblem[], requests: ProblemRequest[]): string | null {
  if (problems.length !== requests.length) return `problems の数が注文と違います(注文 ${requests.length} 問、出力 ${problems.length} 問)。requests と同じ数・同じ順で書いてください。`;
  for (let i = 0; i < problems.length; i++) {
    const p = problems[i];
    const r = requests[i];
    if (p.format !== r.format) return `${i + 1} 問目の format が注文(${r.format})と違います。`;
    if (p.format === 'choice') {
      if (p.choices.length < 2) return `${i + 1} 問目は選択式なのに、choices が2つ以上ありません。`;
      const n = choiceNumber(p.answer);
      if (n === null || n < 1 || n > p.choices.length) return `${i + 1} 問目の answer は、正解の選択肢の番号(1〜${p.choices.length})を書いてください。`;
    }
  }
  return null;
}

interface Verdict {
  ok: boolean;
  reason: string;
  /** 図が崩れていたので、次は図なしで作らせる。 */
  noFigure?: boolean;
}

interface Env {
  core: AppCore;
  args: GenerateArgs;
  ctx: JobContext;
  subjectName: string;
  unitName: (id: string) => string;
}

async function generate(env: Env, requests: Array<ProblemRequest & { avoid?: { body: string; reason: string } | null; noFigure?: boolean }>): Promise<GeneratedProblem[]> {
  const { core, args, ctx } = env;
  const project = getProject(core, args.projectId);
  const sp = core.paths(args.projectId).subject(args.subjectId);
  const trend = existsSync(sp.trendJson) ? readData(sp.trendJson, Files.trend) : null;
  const r = await callClaude({
    projectDir: core.projectDir(args.projectId),
    kind: 'generate_problems',
    vars: { subjectName: env.subjectName, purpose: args.purpose },
    input: {
      subject: env.subjectName,
      purpose: args.purpose,
      project: projectBrief(project),
      requests: requests.map((q, i) => ({
        index: i + 1,
        unitId: q.unitId,
        unitName: env.unitName(q.unitId),
        difficulty: q.difficulty,
        format: q.format,
        origin: PROBLEM_ORIGIN_LABEL[q.origin],
        mistake: q.mistake ? MISTAKE_LABEL[q.mistake] : null,
        reference: q.reference ?? null,
        avoid: q.avoid ?? null,
        noFigure: q.noFigure ?? false,
      })),
      trend: trend ? { format: trend.format, structure: trend.structure, frequentUnits: trend.frequentUnits, volume: trend.volume, difficulty: trend.difficulty } : null,
    },
    schema: GenerateOutputSchema,
    env: core.claudeEnv(),
    signal: ctx.signal,
    check: (d) => checkGenerated(d.problems, requests),
  });
  // 単元・難易度・形式は注文を正とする。選択式でなければ選択肢は持たせない
  return r.data.problems.map((p, i) => ({
    ...p,
    unitId: requests[i].unitId,
    difficulty: requests[i].difficulty,
    choices: p.format === 'choice' ? p.choices : [],
    figureSvg: p.figureSvg && p.figureSvg.trim() ? p.figureSvg : null,
  }));
}

/** 検算: 解答を見せずに解かせ、作成時の答えと照らし合わせる。 */
async function verify(env: Env, problems: GeneratedProblem[]): Promise<Verdict[]> {
  const { core, args, ctx } = env;
  const verdicts: Array<Verdict | null> = problems.map((p) => (p.figureSvg && !isUsableSvg(p.figureSvg) ? { ok: false, reason: '図(SVG)が正しく描けていない', noFigure: true } : null));
  const targets = problems.map((p, i) => ({ p, i })).filter((x) => verdicts[x.i] === null);
  if (targets.length === 0) return verdicts as Verdict[];

  ctx.progress(`検算しています(${targets.length} 問を解き直し)`);
  const solved = await callClaude({
    projectDir: core.projectDir(args.projectId),
    kind: 'solve_problems',
    vars: { subjectName: env.subjectName },
    input: { subject: env.subjectName, problems: targets.map((x, n) => ({ index: n + 1, format: x.p.format, body: x.p.body, choices: x.p.choices, figureSvg: x.p.figureSvg })) },
    schema: SolveOutputSchema,
    env: core.claudeEnv(),
    signal: ctx.signal,
    check: (d) => {
      const missing = targets.findIndex((_x, n) => !d.answers.some((a) => a.index === n + 1));
      return missing < 0 ? null : `index ${missing + 1} の答えがありません(problems と同じ数だけ answers を書く)。`;
    },
  });

  const toJudge: Array<{ i: number; solved: string }> = [];
  targets.forEach((x, n) => {
    const a = solved.data.answers.find((s) => s.index === n + 1)!;
    if (a.issue.trim() || !a.answer.trim()) {
      verdicts[x.i] = { ok: false, reason: `解き直しで問題の不備が見つかった: ${a.issue.trim() || '答えが出せない'}` };
    } else if (x.p.format === 'choice') {
      const same = choiceNumber(a.answer) === choiceNumber(x.p.answer);
      verdicts[x.i] = same ? { ok: true, reason: '' } : { ok: false, reason: `解き直しの答え(選択肢 ${a.answer})が、作成時の答え(選択肢 ${x.p.answer})と違う` };
    } else if (x.p.format === 'short' && normalizeAnswer(a.answer) === normalizeAnswer(x.p.answer)) {
      verdicts[x.i] = { ok: true, reason: '' };
    } else {
      toJudge.push({ i: x.i, solved: a.answer });
    }
  });

  if (toJudge.length > 0) {
    // 書き方の違う短答と、記述式は、採点基準に照らして一致(満点)かを判定させる
    ctx.progress(`検算しています(${toJudge.length} 問の答えを照らし合わせ)`);
    const judged = await callClaude({
      projectDir: core.projectDir(args.projectId),
      kind: 'judge_answers',
      vars: { subjectName: env.subjectName },
      input: {
        subject: env.subjectName,
        items: toJudge.map((j, n) => ({ index: n + 1, format: problems[j.i].format, body: problems[j.i].body, key: problems[j.i].answer, rubric: problems[j.i].rubric, solved: j.solved })),
      },
      schema: JudgeOutputSchema,
      env: core.claudeEnv(),
      signal: ctx.signal,
      check: (d) => {
        const missing = toJudge.findIndex((_x, n) => !d.results.some((a) => a.index === n + 1));
        return missing < 0 ? null : `index ${missing + 1} の判定がありません(items と同じ数だけ results を書く)。`;
      },
    });
    toJudge.forEach((j, n) => {
      const r = judged.data.results.find((x) => x.index === n + 1)!;
      verdicts[j.i] = r.match ? { ok: true, reason: '' } : { ok: false, reason: `解き直しの答えが、作成時の答えと合わない: ${r.reason || '理由の記載なし'}` };
    });
  }
  return verdicts as Verdict[];
}

/**
 * 問題を作り、検算して、通ったものだけを返す。
 * 合わなかった問題は、理由を添えて1回だけ作り直させる。それでも駄目なら捨てて、別の問題を1回だけ作らせる(暫定)。
 */
export async function generateVerified(core: AppCore, args: GenerateArgs, ctx: JobContext): Promise<GenerateResult> {
  if (args.requests.length === 0) throw new Error('作る問題の指定がありません');
  const project = getProject(core, args.projectId);
  const names = unitNameMap(getUnits(core, args.projectId, args.subjectId).tree);
  const env: Env = { core, args, ctx, subjectName: getSubject(project, args.subjectId).name, unitName: (id) => names.get(id) ?? id };

  const events: VerifyEvent[] = [];
  const adopted = new Map<number, GeneratedProblem>();
  const event = (slot: number, outcome: VerifyOutcome, reason: string) => events.push({ slot, unitId: args.requests[slot].unitId, outcome, reason });

  // 1) 作る → 検算
  ctx.progress(`問題を作っています(${args.requests.length} 問)`);
  const first = await generate(env, args.requests);
  const v1 = await verify(env, first);
  const failed: Array<{ slot: number; problem: GeneratedProblem; verdict: Verdict }> = [];
  first.forEach((p, slot) => {
    if (v1[slot].ok) {
      adopted.set(slot, p);
      event(slot, 'adopted', '');
    } else failed.push({ slot, problem: p, verdict: v1[slot] });
  });

  // 2) 合わなかったものは、理由を添えて1回だけ作り直す
  const discarded: Array<{ slot: number; noFigure: boolean }> = [];
  if (failed.length > 0) {
    ctx.progress(`検算で合わなかった ${failed.length} 問を作り直しています`);
    const redo = await generate(
      env,
      failed.map((f) => ({ ...args.requests[f.slot], avoid: { body: f.problem.body, reason: f.verdict.reason }, noFigure: f.verdict.noFigure ?? false })),
    );
    const v2 = await verify(env, redo);
    redo.forEach((p, n) => {
      const f = failed[n];
      if (v2[n].ok) {
        adopted.set(f.slot, p);
        event(f.slot, 'regenerated', f.verdict.reason);
      } else {
        event(f.slot, 'discarded', `${f.verdict.reason} → 作り直しても: ${v2[n].reason}`);
        discarded.push({ slot: f.slot, noFigure: (f.verdict.noFigure || v2[n].noFigure) ?? false });
      }
    });
  }

  // 3) 捨てた分は、別の問題を1回だけ作る(図は使わせない)。これも検算に通らなければ、その注文はあきらめる
  if (discarded.length > 0) {
    ctx.progress(`捨てた ${discarded.length} 問の代わりを作っています`);
    const again = await generate(
      env,
      discarded.map((d) => ({ ...args.requests[d.slot], noFigure: true })),
    );
    const v3 = await verify(env, again);
    again.forEach((p, n) => {
      const d = discarded[n];
      if (v3[n].ok) {
        adopted.set(d.slot, p);
        event(d.slot, 'adopted', '捨てた問題の代わり');
      } else {
        event(d.slot, 'discarded', `代わりの問題も: ${v3[n].reason}`);
      }
    });
  }

  const counts: Record<VerifyOutcome, number> = { adopted: 0, regenerated: 0, discarded: 0 };
  for (const e of events) counts[e.outcome]++;
  const problems = [...adopted.entries()].sort((a, b) => a[0] - b[0]).map(([slot, problem]) => ({ slot, request: args.requests[slot], unitName: env.unitName(problem.unitId), problem }));
  return { problems, events, counts };
}
