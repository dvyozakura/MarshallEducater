// 解説・授業ノート・質問。どれも Claude が書き、プロジェクトのフォルダに普通のファイルとして残す。
import type { MadeBy } from '../shared/engines';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { choiceMark } from '../shared/labels';
import {
  ChatOutputSchema,
  ExplainOutputSchema,
  FORMAT_VERSION,
  MISTAKE_LABEL,
  NoteOutputSchema,
  type AnswerKey,
  type Chat,
  type ChatContext,
  type Explanations,
  type Grading,
  type Problem,
  type Reading,
  type Test,
} from '../shared/schema';
import { flattenUnits } from '../shared/subjects';
import { getReading } from './answers';
import type { AppCore } from './app';
import { callClaude, ClaudeError } from './claude/task';
import { newId, readTextIfExists, safeFileName, writeFileAtomic } from './fsutil';
import { effectiveScore, getAnswerKey, getGrading } from './grading';
import type { JobContext } from './jobs';
import { getProject, getSubject } from './projects';
import { Files, readData, writeData } from './store';
import { getTest, listTests, testPaths } from './tests';
import { getChapter, getTextbookView } from './textbook';
import { getTrend } from './trend';
import { getUnits, projectBrief } from './units';
import { dominantMistake, getWeaknessView } from './weakness';
import { isTategaki } from './projects';

// ───── 数値は暫定(DECISIONS.md に記録) ─────
/** 1回の呼び出しで解説を書かせる設問の数。 */
export const EXPLAIN_CHUNK = 8;
/** 質問に添える、これまでのやりとりの数(新しいものから)。 */
export const CHAT_HISTORY_MAX = 20;
/** 質問に添える、弱い単元の数。 */
export const CHAT_WEAK_UNITS = 8;
/** 授業ノートに添える、その単元で間違えた問題の数。 */
export const NOTE_MISTAKES_MAX = 6;

// ───────── 解説 ─────────

export function getExplanations(core: AppCore, projectId: string, subjectId: string, testId: string): Explanations | null {
  const f = testPaths(core, projectId, subjectId, testId).explanationsJson;
  return existsSync(f) ? readData(f, Files.explanations) : null;
}

/** 満点でなかった設問(上書き後の点数で見る)。 */
export function wrongProblemIds(grading: Grading): string[] {
  return grading.items.filter((i) => effectiveScore(i) < i.max).map((i) => i.problemId);
}

/** 解説がまだ無い、間違えた設問。 */
export function missingExplanations(grading: Grading, explanations: Explanations | null): string[] {
  const have = new Set((explanations?.items ?? []).map((i) => i.problemId));
  return wrongProblemIds(grading).filter((id) => !have.has(id));
}

function answerLabel(p: Problem, answer: string): string {
  if (!answer.trim()) return '(未解答)';
  if (p.format !== 'choice') return answer;
  const n = Number(answer.normalize('NFKC').match(/\d+/)?.[0] ?? NaN);
  return Number.isFinite(n) && p.choices[n - 1] !== undefined ? `${choiceMark(n - 1)} ${p.choices[n - 1]}` : answer;
}

/** 人が読める解説(explanations.md)。Claude Code でフォルダを直接開いたときにも読める。 */
export function explanationsMarkdown(test: Test, grading: Grading, key: AnswerKey, reading: Reading | null, ex: Explanations): string {
  const lines = [`# ${test.title} の解説`, '', `更新: ${ex.updatedAt.slice(0, 10)}`, ''];
  for (const p of test.problems) {
    const e = ex.items.find((i) => i.problemId === p.id);
    const g = grading.items.find((i) => i.problemId === p.id);
    if (!e || !g) continue;
    const k = key.items.find((i) => i.problemId === p.id);
    const answer = reading?.answers.find((a) => a.problemId === p.id)?.answer ?? '';
    lines.push(
      `## ${p.number}(${p.unitName}・${effectiveScore(g)} / ${g.max} 点${g.mistake ? `・${MISTAKE_LABEL[g.mistake]}` : ''})`,
      '',
      p.body.trim(),
      '',
      ...p.choices.map((c, i) => `- ${choiceMark(i)} ${c}`),
      ...(p.choices.length ? [''] : []),
      `- あなたの答案: ${answerLabel(p, answer)}`,
      `- 正解: ${answerLabel(p, k?.answer ?? '')}`,
      '',
      '### 考え方',
      e.thinking.trim(),
      '',
      '### 解き方',
      e.solution.trim(),
      '',
      '### 同じミスを防ぐ一言',
      e.tip.trim(),
      '',
    );
  }
  return lines.join('\n');
}

/**
 * 間違えた問題ごとの解説(考え方 → 解き方 → 同じミスを防ぐ一言)を Claude に書かせる。
 * すでに解説のある設問は書き直さない(all を渡すと、間違えた設問すべてを書き直す)。
 */
export async function explainTest(core: AppCore, projectId: string, subjectId: string, testId: string, ctx: JobContext, all = false): Promise<Explanations> {
  const project = getProject(core, projectId);
  const subject = getSubject(project, subjectId);
  const test = getTest(core, projectId, subjectId, testId);
  const grading = getGrading(core, projectId, subjectId, testId);
  if (!grading) throw new Error('このテストは、まだ採点されていません。解説は採点のあとに作ります。');
  const key = getAnswerKey(core, projectId, subjectId, testId);
  const reading = getReading(core, projectId, subjectId, testId);
  const tp = testPaths(core, projectId, subjectId, testId);
  const previous = getExplanations(core, projectId, subjectId, testId);
  const targets = new Set(all ? wrongProblemIds(grading) : missingExplanations(grading, previous));
  const problems = test.problems.filter((p) => targets.has(p.id));
  let items = (previous?.items ?? []).filter((i) => !targets.has(i.problemId));
  let madeBy: MadeBy | null = previous?.madeBy ?? null;

  for (let at = 0; at < problems.length; at += EXPLAIN_CHUNK) {
    const chunk = problems.slice(at, at + EXPLAIN_CHUNK);
    ctx.progress(problems.length > EXPLAIN_CHUNK ? `${core.who('explain', projectId)} が解説を書いています(${at + 1}〜${at + chunk.length} / ${problems.length} 問)` : `${core.who('explain', projectId)} が解説を書いています(${problems.length} 問)`);
    const r = await callClaude({
      projectDir: core.projectDir(projectId),
      kind: 'explain',
      tategaki: isTategaki(core, projectId, subjectId),
      vars: { subjectName: subject.name, testTitle: test.title },
      input: {
        subject: subject.name,
        project: projectBrief(project),
        items: chunk.map((p) => {
          const g = grading.items.find((i) => i.problemId === p.id)!;
          const k = key.items.find((i) => i.problemId === p.id);
          return {
            problemId: p.id,
            number: p.number,
            format: p.format,
            unitName: p.unitName,
            difficulty: p.difficulty,
            points: p.points,
            body: p.body,
            choices: p.choices,
            key: k?.answer ?? '',
            rubric: k?.rubric ?? '',
            solution: k?.solution ?? '',
            answer: reading?.answers.find((a) => a.problemId === p.id)?.answer ?? '',
            score: effectiveScore(g),
            mistake: g.mistake,
            rationale: g.rationale,
            comment: g.comment,
          };
        }),
      },
      schema: ExplainOutputSchema,
      env: core.claudeEnv(),
      signal: ctx.signal,
      check: (d) => {
        for (const p of chunk) {
          const e = d.items.find((i) => i.problemId === p.id);
          if (!e) return `設問 ${p.id}(${p.number})の解説がありません。items のすべての設問について書いてください。`;
          if (!e.thinking.trim() || !e.solution.trim() || !e.tip.trim()) return `設問 ${p.id} の thinking・solution・tip は、どれも空にしないでください。`;
        }
        return null;
      },
    });
    madeBy = r.madeBy;
    items = [...items, ...chunk.map((p) => r.data.items.find((i) => i.problemId === p.id)!)];
    // 途中で止まっても、できた分は残す
    const order = new Map(test.problems.map((p, i) => [p.id, i]));
    items.sort((a, b) => (order.get(a.problemId) ?? 0) - (order.get(b.problemId) ?? 0));
    const saved = writeData(tp.explanationsJson, Files.explanations, { version: FORMAT_VERSION, testId, updatedAt: new Date().toISOString(), items, madeBy });
    writeFileAtomic(tp.explanationsMd, explanationsMarkdown(test, grading, key, reading, saved));
  }
  return getExplanations(core, projectId, subjectId, testId) ?? writeData(tp.explanationsJson, Files.explanations, { version: FORMAT_VERSION, testId, updatedAt: new Date().toISOString(), items });
}

// ───────── 授業ノート ─────────

export interface NoteInfo {
  unitId: string;
  unitName: string;
  hasNote: boolean;
  updatedAt: string | null;
  /** 習熟度(記録が無ければ null)。 */
  mastery: number | null;
}

function notePath(core: AppCore, projectId: string, subjectId: string, unitId: string): string {
  return core.paths(projectId).subject(subjectId).note(safeFileName(unitId));
}

/** 単元(出題の対象の葉)ごとの、授業ノートの有無。習熟度の低い単元が先。 */
export function listNotes(core: AppCore, projectId: string, subjectId: string): NoteInfo[] {
  const units = flattenUnits(getUnits(core, projectId, subjectId).tree).filter((u) => u.leaf);
  const mastery = new Map(getWeaknessView(core, projectId, subjectId).rows.map((r) => [r.unitId, r.mastery]));
  return units
    .map((u, i) => {
      const f = notePath(core, projectId, subjectId, u.id);
      const has = existsSync(f);
      return { unitId: u.id, unitName: u.fullName, hasNote: has, updatedAt: has ? statSync(f).mtime.toISOString() : null, mastery: mastery.get(u.id) ?? null, weight: u.weight, i };
    })
    .filter((u) => u.weight > 0 || u.hasNote)
    .sort((a, b) => (a.mastery ?? 101) - (b.mastery ?? 101) || a.i - b.i)
    .map(({ weight: _w, i: _i, ...rest }) => rest);
}

export function getNote(core: AppCore, projectId: string, subjectId: string, unitId: string): { unitId: string; unitName: string; markdown: string; updatedAt: string } | null {
  const f = notePath(core, projectId, subjectId, unitId);
  const markdown = readTextIfExists(f);
  if (markdown === null) return null;
  const unit = flattenUnits(getUnits(core, projectId, subjectId).tree).find((u) => u.id === unitId);
  return { unitId, unitName: unit?.fullName ?? unitId, markdown, updatedAt: statSync(f).mtime.toISOString() };
}

/** その単元で間違えた問題(新しい順)。授業ノートの「よくある誤り」の材料。 */
export function unitMistakes(core: AppCore, projectId: string, subjectId: string, unitId: string): Array<{ body: string; mistake: string | null; comment: string }> {
  const out: Array<{ body: string; mistake: string | null; comment: string; at: string }> = [];
  for (const t of listTests(core, projectId, subjectId)) {
    if (t.status !== 'graded') continue;
    const g = getGrading(core, projectId, subjectId, t.id);
    if (!g) continue;
    for (const item of g.items) {
      if (item.unitId !== unitId || effectiveScore(item) >= item.max) continue;
      const p = t.problems.find((q) => q.id === item.problemId);
      if (p) out.push({ body: p.body.slice(0, 400), mistake: item.mistake ? MISTAKE_LABEL[item.mistake] : null, comment: item.comment, at: g.gradedAt });
    }
  }
  return out
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, NOTE_MISTAKES_MAX)
    .map(({ at: _at, ...rest }) => rest);
}

/** 単元の授業ノート(要点・例題・よくある誤り)を Claude に書かせ、notes/<単元>.md に保存する。 */
export async function createNote(core: AppCore, projectId: string, subjectId: string, unitId: string, ctx: JobContext): Promise<{ unitId: string; chars: number }> {
  const project = getProject(core, projectId);
  const subject = getSubject(project, subjectId);
  const units = flattenUnits(getUnits(core, projectId, subjectId).tree);
  const unit = units.find((u) => u.id === unitId);
  if (!unit) throw new Error('その単元は、この科目の単元ツリーにありません。');
  const row = getWeaknessView(core, projectId, subjectId).rows.find((r) => r.unitId === unitId);
  const trend = getTrend(core, projectId, subjectId);
  const file = notePath(core, projectId, subjectId, unitId);
  ctx.progress(`${core.who('note', projectId)} が「${unit.name}」の授業ノートを書いています`);
  const r = await callClaude({
    projectDir: core.projectDir(projectId),
    kind: 'note',
    tategaki: isTategaki(core, projectId, subjectId),
    vars: { subjectName: subject.name, unitName: unit.name },
    input: {
      subject: subject.name,
      project: projectBrief(project),
      unit: { id: unit.id, name: unit.name, fullName: unit.fullName },
      siblings: units.filter((u) => u.leaf && u.id !== unitId).map((u) => u.fullName),
      weakness: row ? { mastery: row.mastery, attempts: row.attempts, mistakes: Object.fromEntries(Object.entries(row.mistakes).map(([m, n]) => [MISTAKE_LABEL[m as keyof typeof MISTAKE_LABEL], n])) } : null,
      mistakes: unitMistakes(core, projectId, subjectId, unitId),
      trend: trend ? { frequentUnits: trend.frequentUnits, format: trend.format, difficulty: trend.difficulty } : null,
      previous: readTextIfExists(file),
    },
    schema: NoteOutputSchema,
    env: core.claudeEnv(),
    signal: ctx.signal,
    check: (d) => (d.markdown.trim().length < 20 ? 'markdown が短すぎます。要点・例題・よくある誤り・確認問題を書いてください。' : null),
  });
  writeFileAtomic(file, `${r.data.markdown.trim()}\n`);
  return { unitId, chars: r.data.markdown.length };
}

// ───────── 質問 ─────────

function chatFile(core: AppCore, projectId: string, subjectId: string, chatId: string): string {
  if (!/^[\w-]+$/.test(chatId)) throw new Error('質問の ID が正しくありません。');
  return core.paths(projectId).subject(subjectId).chat(chatId);
}

export function getChat(core: AppCore, projectId: string, subjectId: string, chatId: string): Chat {
  return readData(chatFile(core, projectId, subjectId, chatId), Files.chat);
}

export interface ChatListItem {
  id: string;
  title: string;
  updatedAt: string;
  messages: number;
  /** 最後の質問に、まだ答えが付いていない。 */
  waiting: boolean;
  context: ChatContext;
}

export function listChats(core: AppCore, projectId: string, subjectId: string): ChatListItem[] {
  const dir = core.paths(projectId).subject(subjectId).chatsDir;
  if (!existsSync(dir)) return [];
  const out: ChatListItem[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const c = readData(join(dir, name), Files.chat);
      out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, messages: c.messages.length, waiting: c.messages.at(-1)?.role === 'user', context: c.context });
    } catch {
      /* 壊れたファイルは一覧に出さない */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface ChatView {
  chat: Chat;
  /** 何についての質問か(画面の見出し用)。 */
  contextLabel: string;
  problem: Problem | null;
  testTitle: string | null;
}

function describeContext(core: AppCore, projectId: string, subjectId: string, context: ChatContext): Omit<ChatView, 'chat'> {
  if (context.testId) {
    try {
      const test = getTest(core, projectId, subjectId, context.testId);
      const problem = test.problems.find((p) => p.id === context.problemId) ?? null;
      return { contextLabel: problem ? `「${test.title}」の ${problem.number}` : `「${test.title}」`, problem, testTitle: test.title };
    } catch {
      return { contextLabel: '(もとのテストは、もうありません)', problem: null, testTitle: null };
    }
  }
  if (context.chapterUnitId) {
    const row = getTextbookView(core, projectId, subjectId).chapters.find((c) => c.unitId === context.chapterUnitId);
    const label = row ? `${row.no > 0 ? `第${row.no}章` : ''}「${row.name}」` : `「${context.chapterUnitId}」`;
    return { contextLabel: `教材 ${label}`, problem: null, testTitle: null };
  }
  if (context.textbook) return { contextLabel: '教材(科目全体)', problem: null, testTitle: null };
  if (context.unitId) {
    const unit = flattenUnits(getUnits(core, projectId, subjectId).tree).find((u) => u.id === context.unitId);
    return { contextLabel: `授業ノート「${unit?.name ?? context.unitId}」`, problem: null, testTitle: null };
  }
  return { contextLabel: '科目全般', problem: null, testTitle: null };
}

function normalizeContext(context: Partial<ChatContext> | undefined): ChatContext {
  return {
    testId: context?.testId ?? null,
    problemId: context?.problemId ?? null,
    unitId: context?.unitId ?? null,
    chapterUnitId: context?.chapterUnitId ?? null,
    textbook: context?.textbook ?? false,
  };
}

/**
 * 教材の質問のやりとり(章ごと、または科目全体)のうち、いちばん新しいもの。無ければ null。
 * 会話は章ごとに保存し、章を開き直すと続きができる。
 */
export function findTextbookChat(core: AppCore, projectId: string, subjectId: string, target: { chapterUnitId: string | null }): ChatView | null {
  const hit = listChats(core, projectId, subjectId).find((c) => (target.chapterUnitId ? c.context.chapterUnitId === target.chapterUnitId : c.context.textbook && !c.context.chapterUnitId));
  return hit ? getChatView(core, projectId, subjectId, hit.id) : null;
}

export function getChatView(core: AppCore, projectId: string, subjectId: string, chatId: string): ChatView {
  const chat = getChat(core, projectId, subjectId, chatId);
  return { chat, ...describeContext(core, projectId, subjectId, chat.context) };
}

/** 新しい質問の画面用: まだやりとりの無い文脈の説明。 */
export function previewChatContext(core: AppCore, projectId: string, subjectId: string, context: Partial<ChatContext>): Omit<ChatView, 'chat'> {
  return describeContext(core, projectId, subjectId, normalizeContext(context));
}

/** 「ここを質問」で添える引用の長さの上限(字)。 */
export const QUOTE_MAX = 1500;

/**
 * 質問を保存する(答えは、このあとのジョブで付く)。chatId が無ければ新しいやりとりを始める。
 * 前の質問に答えが付いていなければ(失敗・取り消し)、その質問を置き換える。
 */
export function postQuestion(
  core: AppCore,
  projectId: string,
  subjectId: string,
  input: { chatId?: string | null; context?: Partial<ChatContext>; question: string; quote?: string | null },
): Chat {
  const question = input.question.trim();
  if (!question) throw new Error('質問を書いてください。');
  if (question.length > 4000) throw new Error('質問が長すぎます(4000 字まで)。');
  const quoted = input.quote?.trim() ? input.quote.trim().slice(0, QUOTE_MAX) : null;
  getSubject(getProject(core, projectId), subjectId);
  const at = new Date().toISOString();
  const message = { role: 'user' as const, text: question, at, ...(quoted ? { quote: quoted } : {}) };
  if (input.chatId) {
    const chat = getChat(core, projectId, subjectId, input.chatId);
    const messages = chat.messages.at(-1)?.role === 'user' ? chat.messages.slice(0, -1) : chat.messages;
    return writeData(chatFile(core, projectId, subjectId, chat.id), Files.chat, { ...chat, messages: [...messages, message], updatedAt: at });
  }
  const id = newId('chat');
  const context = normalizeContext(input.context);
  const title = question.replace(/\s+/g, ' ').slice(0, 40);
  return writeData(chatFile(core, projectId, subjectId, id), Files.chat, {
    version: FORMAT_VERSION,
    id,
    subjectId,
    title,
    context,
    sessionId: null,
    messages: [message],
    createdAt: at,
    updatedAt: at,
  });
}

/** 質問に渡す文脈: その問題・自分の答案・採点・解説(または授業ノート)。 */
function chatContextInput(core: AppCore, projectId: string, subjectId: string, context: ChatContext): Record<string, unknown> {
  const out: Record<string, unknown> = { problem: null, answer: null, grading: null, explanation: null, note: null };
  if (context.testId && context.problemId) {
    let test: Test | null = null;
    try {
      test = getTest(core, projectId, subjectId, context.testId);
    } catch {
      test = null;
    }
    const p = test?.problems.find((q) => q.id === context.problemId);
    if (test && p) {
      const grading = getGrading(core, projectId, subjectId, test.id);
      const g = grading?.items.find((i) => i.problemId === p.id) ?? null;
      // 正解と解き方は、採点が済んでから渡す(解いている途中の問題の答えを教えないため)
      const k = grading ? getAnswerKey(core, projectId, subjectId, test.id).items.find((i) => i.problemId === p.id) : undefined;
      out.problem = {
        testTitle: test.title,
        number: p.number,
        unitName: p.unitName,
        format: p.format,
        difficulty: p.difficulty,
        points: p.points,
        body: p.body,
        choices: p.choices,
        ...(k ? { key: k.answer, rubric: k.rubric, solution: k.solution } : {}),
      };
      out.answer = getReading(core, projectId, subjectId, test.id)?.answers.find((a) => a.problemId === p.id)?.answer ?? null;
      out.grading = g ? { score: effectiveScore(g), max: g.max, rationale: g.rationale, mistake: g.mistake ? MISTAKE_LABEL[g.mistake] : null, comment: g.comment } : null;
      const e = getExplanations(core, projectId, subjectId, test.id)?.items.find((i) => i.problemId === p.id);
      out.explanation = e ? { thinking: e.thinking, solution: e.solution, tip: e.tip } : null;
    }
  }
  if (context.unitId) {
    const note = getNote(core, projectId, subjectId, context.unitId);
    out.note = note ? { unitName: note.unitName, markdown: note.markdown } : null;
  }
  out.chapter = null;
  out.unitWeakness = null;
  out.textbook = null;
  if (context.chapterUnitId) {
    const ch = getChapter(core, projectId, subjectId, context.chapterUnitId);
    const row = getTextbookView(core, projectId, subjectId).chapters.find((c) => c.unitId === context.chapterUnitId);
    out.chapter = ch
      ? {
          no: row?.no ?? null,
          title: ch.title,
          chapterVersion: ch.chapterVersion,
          intro: ch.intro,
          points: ch.points,
          pitfalls: ch.pitfalls,
          examples: ch.examples.map((e) => ({ body: e.body, choices: e.choices, answer: e.answer, solution: e.solution })),
          // 確認問題は、答えを渡さない(解く前に答えを教えないため)
          quiz: ch.quiz.map((q) => ({ body: q.body, choices: q.choices })),
          supplements: ch.supplements.map((s) => ({ title: s.title, markdown: s.markdown })),
        }
      : null;
    const w = getWeaknessView(core, projectId, subjectId).rows.find((r) => r.unitId === context.chapterUnitId);
    out.unitWeakness = w
      ? { unitName: w.unitName, mastery: w.mastery, attempts: w.attempts, mistakes: Object.fromEntries(Object.entries(w.mistakes).map(([m, n]) => [MISTAKE_LABEL[m as keyof typeof MISTAKE_LABEL], n])) }
      : null;
  }
  if (context.textbook && !context.chapterUnitId) {
    const tb = getTextbookView(core, projectId, subjectId);
    out.textbook = {
      chapters: tb.chapters.map((c) => ({ no: c.no, title: c.title, status: c.status, read: c.read, unlearned: c.unlearned, mastery: c.mastery })),
    };
  }
  return out;
}

/** 最後の質問に Claude が答え、やりとりに足して保存する。会話の続きは `--resume` でつなぐ。 */
export async function answerChat(core: AppCore, projectId: string, subjectId: string, chatId: string, ctx: JobContext): Promise<Chat> {
  const project = getProject(core, projectId);
  const subject = getSubject(project, subjectId);
  const chat = getChat(core, projectId, subjectId, chatId);
  const last = chat.messages.at(-1);
  if (!last || last.role !== 'user') throw new Error('答える質問がありません。');
  const weakness = getWeaknessView(core, projectId, subjectId);
  const call = (resumeSessionId: string | undefined) =>
    callClaude({
      projectDir: core.projectDir(projectId),
      kind: 'chat',
      tategaki: isTategaki(core, projectId, subjectId),
      vars: { subjectName: subject.name },
      input: {
        subject: subject.name,
        project: projectBrief(project),
        context: chatContextInput(core, projectId, subjectId, chat.context),
        weakness: {
          overall: weakness.overall,
          units: weakness.rows.slice(0, CHAT_WEAK_UNITS).map((r) => {
            const m = dominantMistake(r);
            return { unitName: r.unitName, mastery: r.mastery, attempts: r.attempts, frequentMistake: m ? MISTAKE_LABEL[m] : null };
          }),
        },
        history: chat.messages
          .slice(0, -1)
          .slice(-CHAT_HISTORY_MAX)
          .map((m) => ({ role: m.role, text: m.text, ...(m.quote ? { quote: m.quote } : {}) })),
        question: last.text,
        quote: last.quote ?? null,
      },
      schema: ChatOutputSchema,
      env: core.claudeEnv(),
      signal: ctx.signal,
      resumeSessionId,
      check: (d) => (d.answer.trim() ? null : 'answer を空にしないでください。'),
    });
  ctx.progress(`${core.who('chat', projectId)} が質問に答えています`);
  let r;
  try {
    r = await call(chat.sessionId ?? undefined);
  } catch (e) {
    // 前の会話を続けられないとき(会話の記録が消えた、など)は、新しい会話でやり直す。これまでのやりとりは入力ファイルで渡している
    if (!(chat.sessionId && e instanceof ClaudeError && e.kind === 'other')) throw e;
    ctx.progress('前の会話を続けられなかったので、新しい会話で答えています');
    r = await call(undefined);
  }
  // 待っている間に書き換わっているかもしれないので、読み直してから足す
  const now = getChat(core, projectId, subjectId, chatId);
  if (now.messages.at(-1)?.role !== 'user' || now.messages.at(-1)?.text !== last.text) throw new Error('答えを待っている間に、質問が書き換えられました。もう一度質問してください。');
  const at = new Date().toISOString();
  return writeData(chatFile(core, projectId, subjectId, chatId), Files.chat, {
    ...now,
    sessionId: r.sessionId ?? now.sessionId,
    messages: [...now.messages, { role: 'assistant' as const, text: r.data.answer.trim(), at, madeBy: r.madeBy }],
    updatedAt: at,
  });
}
