// 体系的な教材: 目次(toc.json)と章の状態、既読・未習の印。章を作る処理は textbook_build.ts。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  FORMAT_VERSION,
  THICKNESS_LABEL,
  type Chapter,
  type ChapterReview,
  type ChapterStatus,
  type Difficulty,
  type ExamType,
  type ProblemFormat,
  type TestStatus,
  type Thickness,
  type Toc,
  type TocChapter,
} from '../shared/schema';
import { flattenUnits } from '../shared/subjects';
import type { AppCore } from './app';
import { safeFileName } from './fsutil';
import { effectiveScore, getGrading } from './grading';
import { getProject, getSubject } from './projects';
import { Files, readData, readDataOr, writeData } from './store';
import { getTest } from './tests';
import { getUnits } from './units';
import { getWeaknessView } from './weakness';

// ───── 数値は暫定(DECISIONS.md に記録) ─────
/** 習熟度がこれ未満の単元は「詳しい」章にする。 */
export const THICK_BELOW = 45;
/** 習熟度がこれ以上の単元は「要点中心」の章にする。 */
export const THIN_FROM = 75;
/** 作ったときから習熟度がこれ以上動き、厚さの区分も変わったら「作り直しを提案」。 */
export const STALE_MASTERY_DIFF = 15;
/** ジョブの種類(目次の「作成中」の判定に使う)。 */
export const CHAPTER_JOB_KIND = 'create_chapter';

export interface ChapterSpec {
  thickness: Thickness;
  /** 例題(易しい順)。 */
  examples: Array<{ difficulty: Difficulty; format: ProblemFormat }>;
  /** 確認問題。 */
  quiz: Array<{ difficulty: Difficulty; format: ProblemFormat }>;
  /** 本文の長さの目安(字)。 */
  chars: string;
  /** 書き方の指示(プロンプトに渡す)。 */
  style: string;
}

/** 厚さの区分。未習なら、習熟度にかかわらず詳しく。診断前(習熟度が無い)は標準。 */
export function thicknessFor(mastery: number | null, unlearned: boolean): Thickness {
  if (unlearned) return 'thick';
  if (mastery === null) return 'standard';
  if (mastery < THICK_BELOW) return 'thick';
  if (mastery >= THIN_FROM) return 'thin';
  return 'standard';
}

/** 習熟度 → 詳しさ・例題の数・確認問題の数。試験の型で形式を決める(共通テスト型はすべて選択式)。 */
export function chapterSpec(mastery: number | null, unlearned: boolean, examType: ExamType): ChapterSpec {
  const thickness = thicknessFor(mastery, unlearned);
  const fmt = (d: Difficulty): ProblemFormat => (examType === 'kyotsu' ? 'choice' : d === 'target' && examType === 'kokkoritsu' ? 'essay' : 'short');
  const list = (ds: Difficulty[]) => ds.map((difficulty) => ({ difficulty, format: fmt(difficulty) }));
  if (thickness === 'thick') {
    return {
      thickness,
      examples: list(unlearned ? ['easy', 'easy', 'standard', 'standard'] : ['easy', 'standard', 'standard', 'target']),
      quiz: list(['easy', 'easy', 'standard', 'standard']),
      chars: '2500〜5000',
      style: unlearned
        ? 'この単元は未習。前提となる知識(前の学年・前の章の内容)の確認から始め、用語を1つずつ定義し、飛躍なく丁寧に書く。'
        : 'この単元は苦手。つまずきやすい所を1歩ずつ分けて、理由を省かずに詳しく書く。',
    };
  }
  if (thickness === 'thin') {
    return {
      thickness,
      examples: list(['target']),
      quiz: list(['standard', 'target']),
      chars: '600〜1500',
      style: 'この単元は得意。基本の説明は省き、要点の整理と、目標校レベルで差がつく点に絞って短く書く。',
    };
  }
  return {
    thickness,
    examples: list(['easy', 'standard']),
    quiz: list(['easy', 'standard', 'target']),
    chars: '1500〜3000',
    style: mastery === null ? 'まだ実力が分からない単元。教科書の標準的な詳しさで書く。' : '標準の詳しさで書く。',
  };
}

/** 単元 ID をファイル名にする。 */
export const chapterFileId = (unitId: string): string => safeFileName(unitId);

export function textbookPaths(core: AppCore, projectId: string, subjectId: string) {
  return core.paths(projectId).subject(subjectId).textbook;
}

function emptyToc(): Toc {
  return { version: FORMAT_VERSION, chapters: [], deferred: [], deferredAt: null, updatedAt: null };
}

function newEntry(unitId: string, title: string): TocChapter {
  return {
    unitId,
    title,
    status: 'none',
    staleReason: '',
    read: false,
    readAt: null,
    unlearned: false,
    chapterVersion: 0,
    builtAt: null,
    thickness: null,
    masteryAtBuild: null,
    unlearnedAtBuild: null,
    orphan: false,
    quizTestId: null,
  };
}

/** その章を作っているジョブ(待ち・実行中)。 */
export function activeChapterJob(core: AppCore, projectId: string, subjectId: string, unitId: string) {
  return (
    core.jobs.list().find((j) => {
      if (j.kind !== CHAPTER_JOB_KIND || (j.status !== 'queued' && j.status !== 'running')) return false;
      const p = j.params as { projectId?: string; subjectId?: string; unitId?: string } | null;
      return p?.projectId === projectId && p.subjectId === subjectId && p.unitId === unitId;
    }) ?? null
  );
}

/** 「作り直しを提案」の理由。提案しないなら空。 */
export function staleReasonFor(c: TocChapter, mastery: number | null): string {
  if (c.chapterVersion === 0 || !c.thickness) return '';
  if (c.unlearnedAtBuild !== null && c.unlearned !== c.unlearnedAtBuild) {
    return c.unlearned ? '「未習」の印が付きました。前提から丁寧に書いた章に作り直せます。' : '「未習」の印が外れました。いまの習熟度に合わせた章に作り直せます。';
  }
  const now = thicknessFor(mastery, c.unlearned);
  if (now === c.thickness || mastery === null) return '';
  if (c.masteryAtBuild === null) return `診断の結果、この単元の習熟度は ${mastery} でした。厚さを「${THICKNESS_LABEL[now]}」に変えて作り直せます。`;
  if (Math.abs(mastery - c.masteryAtBuild) >= STALE_MASTERY_DIFF) {
    return `習熟度が ${c.masteryAtBuild} → ${mastery} に変わりました。厚さを「${THICKNESS_LABEL[now]}」に変えて作り直せます。`;
  }
  return '';
}

/**
 * 目次を、いまの単元ツリー・苦手マップ・ファイルの有無に合わせる(変わったときだけ書く)。
 * - 章の並びは単元ツリーの順(出題の対象の葉)。増えた単元は章が増え、名前の変更は題に反映する。
 * - ツリーから外れた単元は、作った章があれば「外れた章」として残し、無ければ目次から消す。
 */
export function syncToc(core: AppCore, projectId: string, subjectId: string): Toc {
  const tb = textbookPaths(core, projectId, subjectId);
  const before = readDataOr(tb.tocJson, Files.toc, emptyToc);
  const units = flattenUnits(getUnits(core, projectId, subjectId).tree).filter((u) => u.leaf && u.weight > 0);
  const mastery = new Map(getWeaknessView(core, projectId, subjectId).rows.map((r) => [r.unitId, r.mastery]));
  const old = new Map(before.chapters.map((c) => [c.unitId, c]));
  const hasFile = (unitId: string) => existsSync(tb.chapterJson(chapterFileId(unitId)));

  const chapters: TocChapter[] = units.map((u) => ({ ...(old.get(u.id) ?? newEntry(u.id, u.fullName)), title: u.fullName, orphan: false }));
  const inTree = new Set(units.map((u) => u.id));
  for (const c of before.chapters) if (!inTree.has(c.unitId) && hasFile(c.unitId)) chapters.push({ ...c, orphan: true });

  for (const c of chapters) {
    const built = hasFile(c.unitId);
    if (!built) {
      // 章のファイルが無い(まだ作っていない、または人が消した)
      Object.assign(c, { chapterVersion: 0, builtAt: null, thickness: null, masteryAtBuild: null, unlearnedAtBuild: null, quizTestId: null, read: false, readAt: null });
    } else if (c.chapterVersion === 0) {
      // 目次が消えた・壊れたあとでも、章のファイルから状態を戻す
      try {
        const ch = readData(tb.chapterJson(chapterFileId(c.unitId)), Files.chapter);
        Object.assign(c, { chapterVersion: ch.chapterVersion, builtAt: ch.updatedAt, thickness: ch.thickness, masteryAtBuild: ch.masteryAtBuild, unlearnedAtBuild: ch.unlearned, quizTestId: ch.quizTestId });
      } catch {
        /* 壊れた章は「未作成」として扱う */
      }
    }
    const reason = c.orphan ? '' : staleReasonFor(c, mastery.get(c.unitId) ?? null);
    let status: ChapterStatus = c.chapterVersion === 0 ? 'none' : reason ? 'stale' : 'done';
    if (activeChapterJob(core, projectId, subjectId, c.unitId)) status = 'generating';
    c.status = status;
    c.staleReason = status === 'stale' ? reason : '';
  }
  const deferred = before.deferred.filter((id) => inTree.has(id) && !hasFile(id));
  const next: Toc = { ...before, version: FORMAT_VERSION, chapters, deferred, deferredAt: deferred.length ? before.deferredAt : null };
  const same = JSON.stringify({ ...before, updatedAt: null }) === JSON.stringify({ ...next, updatedAt: null });
  if (same && existsSync(tb.tocJson)) return before;
  return writeData(tb.tocJson, Files.toc, { ...next, updatedAt: new Date().toISOString() });
}

/** 目次の1章を書き換える(読み直してから書くので、ほかの章の変更を消さない)。 */
export function updateTocChapter(core: AppCore, projectId: string, subjectId: string, unitId: string, patch: Partial<TocChapter>): Toc {
  const tb = textbookPaths(core, projectId, subjectId);
  const toc = syncToc(core, projectId, subjectId);
  if (!toc.chapters.some((c) => c.unitId === unitId)) throw new Error('その単元の章は、目次にありません。');
  writeData(tb.tocJson, Files.toc, { ...toc, chapters: toc.chapters.map((c) => (c.unitId === unitId ? { ...c, ...patch } : c)), updatedAt: new Date().toISOString() });
  return syncToc(core, projectId, subjectId);
}

export function getChapter(core: AppCore, projectId: string, subjectId: string, unitId: string): Chapter | null {
  const f = textbookPaths(core, projectId, subjectId).chapterJson(chapterFileId(unitId));
  return existsSync(f) ? readData(f, Files.chapter) : null;
}

export function getChapterReview(core: AppCore, projectId: string, subjectId: string, unitId: string): ChapterReview | null {
  const f = textbookPaths(core, projectId, subjectId).review(chapterFileId(unitId));
  return existsSync(f) ? readData(f, Files.chapterReview) : null;
}

/** 既読の印を付ける・外す。まだ作っていない章には付けられない。 */
export function setChapterRead(core: AppCore, projectId: string, subjectId: string, unitId: string, read: boolean): Toc {
  if (read && !getChapter(core, projectId, subjectId, unitId)) throw new Error('まだ作っていない章は、既読にできません。');
  return updateTocChapter(core, projectId, subjectId, unitId, { read, readAt: read ? new Date().toISOString() : null });
}

/** 「未習」の印を付ける・外す。 */
export function setChapterUnlearned(core: AppCore, projectId: string, subjectId: string, unitId: string, unlearned: boolean): Toc {
  return updateTocChapter(core, projectId, subjectId, unitId, { unlearned });
}

export interface QuizResult {
  testId: string;
  status: TestStatus;
  /** 問題の数。 */
  total: number;
  /** 満点だった問題の数(採点前は null)。 */
  correct: number | null;
}

/** 章の確認問題の結果(「確認問題: 何問中何問」)。 */
export function quizResult(core: AppCore, projectId: string, subjectId: string, testId: string | null): QuizResult | null {
  if (!testId) return null;
  try {
    const test = getTest(core, projectId, subjectId, testId);
    const grading = test.status === 'graded' ? getGrading(core, projectId, subjectId, testId) : null;
    return { testId, status: test.status, total: test.problems.length, correct: grading ? grading.items.filter((i) => effectiveScore(i) >= i.max).length : null };
  } catch {
    return null; // テストが消されている
  }
}

export interface TextbookChapterView extends TocChapter {
  /** 第何章か(外れた章は 0)。 */
  no: number;
  /** 上位の単元の名前(目次の見出し)。 */
  group: string;
  /** 単元の名前(葉)。 */
  name: string;
  /** いまの習熟度(記録が無ければ null)。 */
  mastery: number | null;
  /** いま作るとしたら、どの厚さになるか。 */
  plannedThickness: Thickness;
  /** 既存の授業ノート(この章の補足として開ける)。 */
  hasNote: boolean;
  /** 作成中のジョブ。 */
  job: { id: string; status: 'queued' | 'running'; progress: string } | null;
  /** 「まとめて作る」で後日に回っている。 */
  deferred: boolean;
  quiz: QuizResult | null;
}

export interface TextbookView {
  subjectId: string;
  subjectName: string;
  chapters: TextbookChapterView[];
  counts: Record<ChapterStatus, number> & { read: number; total: number };
  deferred: string[];
  deferredAt: string | null;
  /** 章の無い単元の授業ノート(単元ツリーから外れた単元のノート。消さずに開けるようにする)。 */
  otherNotes: Array<{ unitId: string; updatedAt: string }>;
}

/** 「教材」タブの目次。 */
export function getTextbookView(core: AppCore, projectId: string, subjectId: string): TextbookView {
  const subject = getSubject(getProject(core, projectId), subjectId);
  const sp = core.paths(projectId).subject(subjectId);
  const toc = syncToc(core, projectId, subjectId);
  const mastery = new Map(getWeaknessView(core, projectId, subjectId).rows.map((r) => [r.unitId, r.mastery]));
  const deferred = new Set(toc.deferred);
  let no = 0;
  const chapters: TextbookChapterView[] = toc.chapters.map((c) => {
    const parts = c.title.split(' > ');
    const job = activeChapterJob(core, projectId, subjectId, c.unitId);
    const m = mastery.get(c.unitId) ?? null;
    return {
      ...c,
      no: c.orphan ? 0 : ++no,
      group: parts.length > 1 ? parts.slice(0, -1).join(' > ') : '',
      name: parts.at(-1) ?? c.title,
      mastery: m,
      plannedThickness: thicknessFor(m, c.unlearned),
      hasNote: existsSync(sp.note(safeFileName(c.unitId))),
      job: job ? { id: job.id, status: job.status as 'queued' | 'running', progress: job.progress } : null,
      deferred: deferred.has(c.unitId),
      quiz: quizResult(core, projectId, subjectId, c.quizTestId),
    };
  });
  const counts = { none: 0, generating: 0, done: 0, stale: 0, read: 0, total: 0 };
  for (const c of chapters) {
    if (c.orphan) continue;
    counts[c.status]++;
    counts.total++;
    if (c.read) counts.read++;
  }
  const chapterNoteFiles = new Set(toc.chapters.map((c) => `${safeFileName(c.unitId)}.md`));
  const otherNotes = existsSync(sp.notesDir)
    ? readdirSync(sp.notesDir)
        .filter((f) => f.endsWith('.md') && !chapterNoteFiles.has(f))
        .map((f) => ({ unitId: f.slice(0, -3), updatedAt: statSync(join(sp.notesDir, f)).mtime.toISOString() }))
    : [];
  return { subjectId, subjectName: subject.name, chapters, counts, deferred: toc.deferred, deferredAt: toc.deferredAt, otherNotes };
}
