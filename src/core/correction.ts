// 読み取り結果の補正(人による修正)と確定。確定した資料だけが、後の処理(採点・分析・類題づくり)に使われる。
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  BBoxSchema,
  FORMAT_VERSION,
  RereadOutputSchema,
  SOURCE_KIND_LABEL,
  type AnswerFormat,
  type BBox,
  type CorrectionEntry,
  type Corrections,
  type Extracted,
  type ExtractedProblem,
  type Reading,
  type SourceKind,
  type SourceMeta,
  type Test,
} from '../shared/schema';
import { leafUnits } from '../shared/subjects';
import type { AppCore } from './app';
import { callClaude } from './claude/task';
import type { JobContext } from './jobs';
import type { SourcePaths } from './paths';
import { getProject, getSubject } from './projects';
import { cropFigure, modeInstructions, testProblemsFor, totalChars } from './reading';
import { listPages, listSources, sourcePaths, testIdOfSubmission } from './sources';
import { Files, readData, readDataOr, writeData } from './store';
import { getUnits } from './units';
import { isTategaki, writingModeOf } from './projects';
import type { WritingMode } from '../shared/notation';

export interface CorrectionView {
  source: SourceMeta;
  /** まだ読み取っていなければ null。 */
  extracted: Extracted | null;
  pages: number[];
  /** 答案のとき: 対応付けの候補(テストの設問)。 */
  targets: Array<{ number: string; format: string; summary: string }> | null;
  units: Array<{ id: string; name: string }>;
  stats: { originalChars: number; changedChars: number; edits: number };
  /** 科目の組み方向(国語は縦書き)。プレビューの向きに使う。 */
  writingMode: WritingMode;
}

/** 編集できる項目。 */
export interface ProblemPatch {
  number?: string;
  major?: string;
  minor?: string;
  points?: number | null;
  body?: string;
  choices?: string[];
  answerFormat?: AnswerFormat;
  unit?: string;
  target?: string | null;
}

interface Ctx {
  core: AppCore;
  projectId: string;
  subjectId: string;
  sourceId: string;
  paths: SourcePaths;
  ex: Extracted;
  corr: Corrections;
}

type EntryIn = Pick<CorrectionEntry, 'problemId' | 'action'> & { before?: string | null; after?: string | null };

/**
 * 直した文字数の目安: 文字ごとの数を比べ、増えた数と減った数の大きいほう。
 * (1文字の置き換え=1、並べ替え・分割・結合だけなら 0)
 */
export function charDiff(a: string, b: string): number {
  const count = new Map<string, number>();
  for (const ch of a) count.set(ch, (count.get(ch) ?? 0) + 1);
  for (const ch of b) count.set(ch, (count.get(ch) ?? 0) - 1);
  let removed = 0;
  let added = 0;
  for (const n of count.values()) {
    if (n > 0) removed += n;
    else added -= n;
  }
  return Math.max(removed, added);
}

const allText = (problems: Array<{ body: string; choices: string[] }>) => problems.map((p) => p.body + p.choices.join('')).join('');

function open(core: AppCore, projectId: string, subjectId: string, sourceId: string): Ctx {
  const paths = sourcePaths(core, projectId, subjectId, sourceId);
  if (!existsSync(paths.extractedJson)) throw new Error('この資料は、まだ読み取られていません。');
  const ex = readData(paths.extractedJson, Files.extracted);
  const corr = readDataOr(paths.correctionsJson, Files.corrections, () => ({ version: FORMAT_VERSION, sourceId, entries: [], originalChars: totalChars(ex.problems), changedChars: 0 }));
  return { core, projectId, subjectId, sourceId, paths, ex, corr };
}

function find(c: Ctx, problemId: string): { p: ExtractedProblem; i: number } {
  const i = c.ex.problems.findIndex((q) => q.id === problemId);
  if (i < 0) throw new Error('その問題は見つかりません(消されたか、結合されました)。');
  return { p: c.ex.problems[i], i };
}

function nextProblemId(c: Ctx): string {
  // 消した・結合した問題の ID も履歴から拾い、使い回さない
  const ids = [...c.ex.problems.map((p) => p.id), ...c.corr.entries.flatMap((e) => [e.problemId, e.before ?? '', e.after ?? ''])];
  const max = ids.reduce((m, id) => Math.max(m, Number(id.match(/^q(\d+)$/)?.[1] ?? 0)), 0);
  return `q${String(max + 1).padStart(3, '0')}`;
}

function setStatus(c: Ctx, status: SourceMeta['status']): void {
  const meta = readData(c.paths.sourceJson, Files.source);
  if (meta.status !== status) writeData(c.paths.sourceJson, Files.source, { ...meta, status });
}

/** 答案の資料なら、テスト側の reading.json とテストの状態も合わせる。 */
function syncSubmission(c: Ctx, confirmed: boolean): void {
  const testId = testIdOfSubmission(c.sourceId);
  if (!testId) return;
  const tp = c.core.paths(c.projectId).subject(c.subjectId).test(testId);
  if (!existsSync(tp.testJson)) return;
  const test: Test = readData(tp.testJson, Files.test);
  if (confirmed) {
    const unmapped = c.ex.problems.filter((a) => a.body.trim() && !test.problems.some((p) => p.number === a.target));
    if (unmapped.length) {
      throw new Error(`どの設問への解答か決まっていない答案があります(${unmapped.map((a) => a.number || a.id).join('、')})。対応する設問を選ぶか、不要なら消してください。`);
    }
    const reading: Reading = {
      version: FORMAT_VERSION,
      testId,
      method: 'scan',
      answers: test.problems.map((p) => ({
        problemId: p.id,
        answer: c.ex.problems
          .filter((a) => a.target === p.number)
          .map((a) => a.body.trim())
          .filter(Boolean)
          .join('\n'),
      })),
      confirmed: true,
      submittedAt: new Date().toISOString(),
      elapsedSec: null,
    };
    writeData(tp.readingJson, Files.reading, reading);
    if (test.status !== 'graded') writeData(tp.testJson, Files.test, { ...test, status: 'submitted' });
  } else if (existsSync(tp.readingJson)) {
    const reading = readData(tp.readingJson, Files.reading);
    if (reading.method === 'scan' && reading.confirmed) {
      writeData(tp.readingJson, Files.reading, { ...reading, confirmed: false });
      if (test.status === 'submitted') writeData(tp.testJson, Files.test, { ...test, status: 'reading' });
    }
  }
}

/** 変更を保存する。内容が変わったら、資料全体の確定は外れる。 */
function commit(c: Ctx, entries: EntryIn[], opts: { sourceConfirmed?: boolean } = {}): void {
  const at = new Date().toISOString();
  const confirmed = opts.sourceConfirmed ?? false;
  if (confirmed) syncSubmission(c, true); // 対応付けに不備があれば、ここで断る(何も保存しない)
  c.ex = writeData(c.paths.extractedJson, Files.extracted, { ...c.ex, confirmedAt: confirmed ? at : null });
  let originalText = '';
  try {
    originalText = allText(readData(c.paths.extractedOriginalJson, Files.extracted).problems);
  } catch {
    /* 控えが無ければ、補正率は出せない */
  }
  c.corr = writeData(c.paths.correctionsJson, Files.corrections, {
    ...c.corr,
    entries: [...c.corr.entries, ...entries.map((e) => ({ at, problemId: e.problemId, action: e.action, before: e.before ?? null, after: e.after ?? null }))],
    originalChars: originalText.length || c.corr.originalChars,
    changedChars: originalText ? charDiff(originalText, allText(c.ex.problems)) : c.corr.changedChars,
  });
  setStatus(c, confirmed ? 'confirmed' : 'read');
  if (!confirmed) syncSubmission(c, false);
}

function view(core: AppCore, projectId: string, subjectId: string, sourceId: string): CorrectionView {
  const paths = sourcePaths(core, projectId, subjectId, sourceId);
  const source = readData(paths.sourceJson, Files.source);
  const extracted = existsSync(paths.extractedJson) ? readData(paths.extractedJson, Files.extracted) : null;
  const corr = existsSync(paths.correctionsJson) ? readData(paths.correctionsJson, Files.corrections) : null;
  return {
    source,
    extracted,
    pages: listPages(paths),
    targets: testProblemsFor(core, projectId, subjectId, source),
    units: leafUnits(getUnits(core, projectId, subjectId).tree).map((u) => ({ id: u.id, name: u.fullName })),
    writingMode: writingModeOf(core, projectId, subjectId),
    stats: { originalChars: corr?.originalChars ?? 0, changedChars: corr?.changedChars ?? 0, edits: corr?.entries.length ?? 0 },
  };
}

export const getCorrectionView = view;

export function getCorrections(core: AppCore, projectId: string, subjectId: string, sourceId: string): Corrections | null {
  const paths = sourcePaths(core, projectId, subjectId, sourceId);
  return existsSync(paths.correctionsJson) ? readData(paths.correctionsJson, Files.corrections) : null;
}

type Ids = [core: AppCore, projectId: string, subjectId: string, sourceId: string];

/** 1問の内容を直す。変わった項目だけを履歴に残す。直した問題の確定は外れる。 */
export function updateProblem(...args: [...Ids, problemId: string, patch: ProblemPatch]): CorrectionView {
  const [core, projectId, subjectId, sourceId, problemId, patch] = args;
  const c = open(core, projectId, subjectId, sourceId);
  const { p, i } = find(c, problemId);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const next: ExtractedProblem = { ...p };
  const keys = ['number', 'major', 'minor', 'points', 'body', 'choices', 'answerFormat', 'unit', 'target'] as const;
  for (const k of keys) {
    if (!(k in patch) || patch[k] === undefined) continue;
    if (JSON.stringify(patch[k]) === JSON.stringify(p[k])) continue;
    before[k] = p[k];
    after[k] = patch[k];
    (next as Record<string, unknown>)[k] = patch[k];
  }
  if (Object.keys(after).length === 0) return view(core, projectId, subjectId, sourceId);
  next.confirmed = false;
  c.ex.problems[i] = next;
  commit(c, [{ problemId, action: 'edit', before: JSON.stringify(before), after: JSON.stringify(after) }]);
  return view(core, projectId, subjectId, sourceId);
}

/** 自信がない箇所の印を「確かめた」として外す。 */
export function resolveUncertain(...args: [...Ids, problemId: string, index: number]): CorrectionView {
  const [core, projectId, subjectId, sourceId, problemId, index] = args;
  const c = open(core, projectId, subjectId, sourceId);
  const { p, i } = find(c, problemId);
  const u = p.uncertain[index];
  if (!u) return view(core, projectId, subjectId, sourceId);
  c.ex.problems[i] = { ...p, uncertain: p.uncertain.filter((_x, n) => n !== index) };
  commit(c, [{ problemId, action: 'edit', before: JSON.stringify({ uncertain: u }), after: JSON.stringify({ uncertain: '確かめた' }) }], { sourceConfirmed: false });
  return view(core, projectId, subjectId, sourceId);
}

/** 本文の at 文字目で2問に分ける。後ろ半分が新しい問題になる。 */
export function splitProblem(...args: [...Ids, problemId: string, at: number]): CorrectionView {
  const [core, projectId, subjectId, sourceId, problemId, at] = args;
  const c = open(core, projectId, subjectId, sourceId);
  const { p, i } = find(c, problemId);
  if (!Number.isInteger(at) || at <= 0 || at >= p.body.length) throw new Error('分ける位置は、本文の途中にしてください(本文の中にカーソルを置いてから押します)。');
  const head = p.body.slice(0, at).trimEnd();
  const tail = p.body.slice(at).trimStart();
  const newId = nextProblemId(c);
  const first: ExtractedProblem = { ...p, body: head, confirmed: false, uncertain: p.uncertain.filter((u) => !u.text || !tail.includes(u.text) || head.includes(u.text)) };
  const second: ExtractedProblem = {
    ...p,
    id: newId,
    number: p.number ? `${p.number}(続き)` : '',
    body: tail,
    points: null,
    choices: [],
    figures: [],
    confirmed: false,
    uncertain: p.uncertain.filter((u) => u.text && tail.includes(u.text) && !head.includes(u.text)),
  };
  c.ex.problems.splice(i, 1, first, second);
  commit(c, [{ problemId, action: 'split', before: p.body, after: newId }]);
  return view(core, projectId, subjectId, sourceId);
}

/** 次の問題とつなげて1問にする。 */
export function mergeWithNext(...args: [...Ids, problemId: string]): CorrectionView {
  const [core, projectId, subjectId, sourceId, problemId] = args;
  const c = open(core, projectId, subjectId, sourceId);
  const { p, i } = find(c, problemId);
  const q = c.ex.problems[i + 1];
  if (!q) throw new Error('最後の問題には、つなげる相手がありません。');
  const merged: ExtractedProblem = {
    ...p,
    body: `${p.body.trimEnd()}\n${q.body.trimStart()}`,
    points: p.points === null && q.points === null ? null : (p.points ?? 0) + (q.points ?? 0),
    choices: [...p.choices, ...q.choices],
    answerFormat: p.answerFormat === 'other' ? q.answerFormat : p.answerFormat,
    unit: p.unit || q.unit,
    target: p.target ?? q.target,
    pages: [...new Set([...p.pages, ...q.pages])].sort((a, b) => a - b),
    figures: [...p.figures, ...q.figures],
    uncertain: [...p.uncertain, ...q.uncertain],
    confirmed: false,
  };
  c.ex.problems.splice(i, 2, merged);
  commit(c, [{ problemId, action: 'merge', before: q.id, after: null }]);
  return view(core, projectId, subjectId, sourceId);
}

/** 並べ替え: 1つ前(-1)か1つ後ろ(+1)へ動かす。 */
export function moveProblem(...args: [...Ids, problemId: string, delta: number]): CorrectionView {
  const [core, projectId, subjectId, sourceId, problemId, delta] = args;
  const c = open(core, projectId, subjectId, sourceId);
  const { p, i } = find(c, problemId);
  const j = i + (delta < 0 ? -1 : 1);
  if (j < 0 || j >= c.ex.problems.length) return view(core, projectId, subjectId, sourceId);
  c.ex.problems.splice(i, 1);
  c.ex.problems.splice(j, 0, p);
  commit(c, [{ problemId, action: 'reorder', before: String(i + 1), after: String(j + 1) }]);
  return view(core, projectId, subjectId, sourceId);
}

function removeFigureFile(c: Ctx, image: string | null): void {
  if (image && /^figures\/[\w.-]+\.png$/.test(image)) rmSync(join(c.paths.root, image), { force: true });
}

export function deleteProblem(...args: [...Ids, problemId: string]): CorrectionView {
  const [core, projectId, subjectId, sourceId, problemId] = args;
  const c = open(core, projectId, subjectId, sourceId);
  const { p, i } = find(c, problemId);
  c.ex.problems.splice(i, 1);
  commit(c, [{ problemId, action: 'delete', before: JSON.stringify({ number: p.number, body: p.body, choices: p.choices }), after: null }]);
  for (const f of p.figures) removeFigureFile(c, f.image);
  return view(core, projectId, subjectId, sourceId);
}

export interface FigureInput {
  /** 無ければ新しい図として足す。 */
  id?: string | null;
  page: number;
  bbox: BBox;
  description?: string;
}

/** 図の切り出し範囲・説明を直す(または図を足す)。範囲が変わったら切り出し直す。 */
export function saveFigure(...args: [...Ids, problemId: string, input: FigureInput]): CorrectionView {
  const [core, projectId, subjectId, sourceId, problemId, input] = args;
  const c = open(core, projectId, subjectId, sourceId);
  const { p, i } = find(c, problemId);
  const bbox = BBoxSchema.parse(input.bbox);
  if (bbox.w < 0.01 || bbox.h < 0.01) throw new Error('図の範囲が小さすぎます。ページの上でドラッグして囲んでください。');
  if (!listPages(c.paths).includes(input.page)) throw new Error(`ページ ${input.page} はこの資料にありません。`);
  const old = input.id ? p.figures.find((f) => f.id === input.id) : undefined;
  if (input.id && !old) throw new Error('その図は見つかりません。');
  const figId = old?.id ?? `${p.id}-f${p.figures.reduce((m, f) => Math.max(m, Number(f.id.match(/-f(\d+)$/)?.[1] ?? 0)), 0) + 1}`;
  const moved = !old || old.page !== input.page || JSON.stringify(old.bbox) !== JSON.stringify(bbox);
  const figure = {
    id: figId,
    page: input.page,
    bbox,
    description: input.description ?? old?.description ?? '',
    image: moved ? cropFigure(core, c.paths, input.page, bbox, figId) : (old?.image ?? null),
  };
  c.ex.problems[i] = { ...p, confirmed: false, figures: old ? p.figures.map((f) => (f.id === figId ? figure : f)) : [...p.figures, figure] };
  commit(c, [
    {
      problemId,
      action: 'figure',
      before: old ? JSON.stringify({ id: figId, page: old.page, bbox: old.bbox, description: old.description }) : null,
      after: JSON.stringify({ id: figId, page: figure.page, bbox, description: figure.description }),
    },
  ]);
  if (moved && old) removeFigureFile(c, old.image);
  return view(core, projectId, subjectId, sourceId);
}

export function deleteFigure(...args: [...Ids, problemId: string, figureId: string]): CorrectionView {
  const [core, projectId, subjectId, sourceId, problemId, figureId] = args;
  const c = open(core, projectId, subjectId, sourceId);
  const { p, i } = find(c, problemId);
  const old = p.figures.find((f) => f.id === figureId);
  if (!old) return view(core, projectId, subjectId, sourceId);
  c.ex.problems[i] = { ...p, confirmed: false, figures: p.figures.filter((f) => f.id !== figureId) };
  commit(c, [{ problemId, action: 'figure', before: JSON.stringify({ id: figureId, page: old.page, bbox: old.bbox }), after: null }]);
  removeFigureFile(c, old.image);
  return view(core, projectId, subjectId, sourceId);
}

/** 切り出した図の画像(画面での表示用)。 */
export function readFigureImage(...args: [...Ids, image: string]): Uint8Array {
  const [core, projectId, subjectId, sourceId, image] = args;
  if (!/^figures\/[\w.-]+\.png$/.test(image)) throw new Error('図の指定が正しくありません');
  const file = join(sourcePaths(core, projectId, subjectId, sourceId).root, image);
  if (!existsSync(file)) throw new Error('図の画像がありません');
  return readFileSync(file);
}

/** 問題ごとの確定・確定の取り消し。 */
export function confirmProblem(...args: [...Ids, problemId: string, confirmed: boolean]): CorrectionView {
  const [core, projectId, subjectId, sourceId, problemId, confirmed] = args;
  const c = open(core, projectId, subjectId, sourceId);
  const { p, i } = find(c, problemId);
  if (p.confirmed === confirmed) return view(core, projectId, subjectId, sourceId);
  c.ex.problems[i] = { ...p, confirmed };
  commit(c, [{ problemId, action: confirmed ? 'confirm' : 'unconfirm' }]);
  return view(core, projectId, subjectId, sourceId);
}

/** 資料ごとの確定。まだの問題もまとめて確定にする。これ以降、後の処理に使われる。 */
export function confirmSource(...args: Ids): CorrectionView {
  const [core, projectId, subjectId, sourceId] = args;
  const c = open(core, projectId, subjectId, sourceId);
  if (c.ex.problems.length === 0) throw new Error('問題が1つもありません。読み取り直すか、資料を消してください。');
  c.ex.problems = c.ex.problems.map((p) => ({ ...p, confirmed: true }));
  commit(c, [{ problemId: '', action: 'confirm_all' }], { sourceConfirmed: true });
  return view(core, projectId, subjectId, sourceId);
}

/** 全体を読み取り直したあと: 前の確定にもとづく答案(reading.json)が残っていれば、未確定に戻す。 */
export function afterReadSource(...args: Ids): void {
  const [core, projectId, subjectId, sourceId] = args;
  syncSubmission(open(core, projectId, subjectId, sourceId), false);
}

/** 資料の確定を取り消す(直したいとき)。 */
export function unconfirmSource(...args: Ids): CorrectionView {
  const [core, projectId, subjectId, sourceId] = args;
  const c = open(core, projectId, subjectId, sourceId);
  if (c.ex.confirmedAt) commit(c, [{ problemId: '', action: 'unconfirm' }]);
  return view(core, projectId, subjectId, sourceId);
}

/** 「ここを読み直して」: 選んだ1問だけ、ヒントを添えて Claude に読み直させる。 */
export async function rereadProblem(core: AppCore, projectId: string, subjectId: string, sourceId: string, problemId: string, hint: string, ctx: JobContext): Promise<ExtractedProblem> {
  const project = getProject(core, projectId);
  const subject = getSubject(project, subjectId);
  const first = open(core, projectId, subjectId, sourceId);
  const target = find(first, problemId).p;
  const meta = readData(first.paths.sourceJson, Files.source);
  const allPages = listPages(first.paths);
  const pages = (target.pages.length ? target.pages.filter((n) => allPages.includes(n)) : allPages).slice(0, 6);
  if (pages.length === 0) throw new Error('読み直すページがありません。');
  const mode = meta.kind === 'answer' ? 'answers' : 'problems';
  const units = leafUnits(getUnits(core, projectId, subjectId).tree).map((u) => ({ id: u.id, name: u.fullName }));
  ctx.progress(`「${target.number || problemId}」を読み直しています`);
  const r = await callClaude({
    projectDir: core.projectDir(projectId),
    kind: 'reread_problem',
    tategaki: isTategaki(core, projectId, subjectId),
    vars: {
      modeLabel: mode === 'answers' ? '答案' : '問題',
      subjectName: subject.name,
      title: meta.title,
      kindLabel: SOURCE_KIND_LABEL[meta.kind],
      modeInstructions: modeInstructions(mode),
      hint: hint.trim() || '(ヒントなし。もう一度ていねいに読んでください)',
    },
    input: {
      mode,
      hint: hint.trim(),
      problem: { number: target.number, major: target.major, minor: target.minor, points: target.points, body: target.body, choices: target.choices, answerFormat: target.answerFormat, unit: target.unit, target: target.target },
      pages: pages.map((n) => ({ page: n, image: first.paths.pageRel(n) })),
      units,
      testProblems: testProblemsFor(core, projectId, subjectId, meta),
    },
    schema: RereadOutputSchema,
    env: core.claudeEnv(),
    signal: ctx.signal,
    check: (d) => {
      const bad = [...d.problem.pages, ...d.problem.figures.map((f) => f.page)].find((n) => !allPages.includes(n));
      return bad === undefined ? null : `ページ ${bad} はこの資料にありません(入力の pages にある番号だけを使う)`;
    },
  });
  // 待っている間に人が他の問題を直しているかもしれないので、読み込み直してから反映する
  const c = open(core, projectId, subjectId, sourceId);
  const { p, i } = find(c, problemId);
  const out = r.data.problem;
  const next: ExtractedProblem = {
    ...p,
    number: out.number || p.number,
    major: out.major || p.major,
    minor: out.minor || p.minor,
    points: out.points ?? p.points,
    body: out.body,
    choices: out.choices,
    answerFormat: out.answerFormat === 'other' ? p.answerFormat : out.answerFormat,
    unit: units.some((u) => u.id === out.unit) ? out.unit : p.unit,
    target: out.target ?? p.target,
    pages: out.pages.length ? out.pages : p.pages,
    uncertain: out.uncertain,
    confirmed: false,
  };
  if (out.figures.length) {
    next.figures = out.figures.map((f, n) => {
      const figId = `${p.id}-f${n + 1}`;
      return { ...f, id: figId, image: cropFigure(core, c.paths, f.page, f.bbox, figId) };
    });
  }
  c.ex.problems[i] = next;
  commit(c, [{ problemId, action: 'reread', before: JSON.stringify({ hint: hint.trim(), body: p.body, choices: p.choices }), after: JSON.stringify({ body: next.body, choices: next.choices }) }]);
  if (out.figures.length) for (const f of p.figures) removeFigureFile(c, f.image);
  return next;
}

// ───── 後の処理(採点・分析・類題づくり)の入口 ─────

/** 確定した資料の問題だけを返す。未確定なら断る。 */
export function requireConfirmedProblems(...args: Ids): ExtractedProblem[] {
  const [core, projectId, subjectId, sourceId] = args;
  const paths = sourcePaths(core, projectId, subjectId, sourceId);
  const meta = readData(paths.sourceJson, Files.source);
  const ex = existsSync(paths.extractedJson) ? readData(paths.extractedJson, Files.extracted) : null;
  if (meta.status !== 'confirmed' || !ex?.confirmedAt) throw new Error(`資料「${meta.title}」は、まだ確定されていません。補正画面で確かめて「確定」してください。`);
  return ex.problems;
}

/** 科目の確定した資料の一覧(種類で絞れる)。未確定のものは含めない。 */
export function listConfirmedSources(core: AppCore, projectId: string, subjectId: string, kind?: SourceKind): Array<{ source: SourceMeta; problems: ExtractedProblem[] }> {
  const out: Array<{ source: SourceMeta; problems: ExtractedProblem[] }> = [];
  for (const source of listSources(core, projectId, subjectId)) {
    if (source.status !== 'confirmed' || (kind && source.kind !== kind)) continue;
    try {
      out.push({ source, problems: requireConfirmedProblems(core, projectId, subjectId, source.id) });
    } catch {
      /* 状態と中身が食い違う資料は使わない */
    }
  }
  return out;
}
