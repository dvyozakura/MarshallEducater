import type { MadeBy } from '../shared/engines';
import { existsSync } from 'node:fs';
import {
  FORMAT_VERSION,
  ReadPagesOutputSchema,
  SOURCE_KIND_LABEL,
  type Extracted,
  type ExtractedProblem,
  type ReadProblem,
  type SourceMeta,
  type Test,
} from '../shared/schema';
import { leafUnits } from '../shared/subjects';
import type { AppCore } from './app';
import { loadPromptFile } from './claude/prompts';
import { callClaude } from './claude/task';
import type { JobContext } from './jobs';
import type { SourcePaths } from './paths';
import { getProject, getSubject } from './projects';
import { listPages, setSourceStatus, sourcePaths } from './sources';
import { Files, readData, writeData } from './store';
import { getUnits } from './units';

/** 1回の呼び出しで読ませるページ数(暫定)。多い資料はこの数ずつに分けて読む。 */
export const READ_CHUNK_PAGES = 4;

export function chunkPages(pages: number[], size = READ_CHUNK_PAGES): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < pages.length; i += size) out.push(pages.slice(i, i + size));
  return out;
}

/**
 * 分けて読んだ結果をつなぐ。ページ群の先頭の問題が「前の続き」なら、前のページ群の最後の問題と結合する。
 */
export function mergeChunks(chunks: ReadProblem[][]): ReadProblem[] {
  const out: ReadProblem[] = [];
  for (const chunk of chunks) {
    chunk.forEach((p, i) => {
      const prev = out[out.length - 1];
      if (i === 0 && p.continuesFromPrevious && prev) {
        out[out.length - 1] = {
          ...prev,
          body: `${prev.body.trimEnd()}\n${p.body.trimStart()}`,
          points: prev.points ?? p.points,
          choices: [...prev.choices, ...p.choices],
          answerFormat: prev.answerFormat === 'other' ? p.answerFormat : prev.answerFormat,
          unit: prev.unit || p.unit,
          pages: [...new Set([...prev.pages, ...p.pages])].sort((a, b) => a - b),
          figures: [...prev.figures, ...p.figures],
          uncertain: [...prev.uncertain, ...p.uncertain],
        };
      } else {
        out.push({ ...p, continuesFromPrevious: false });
      }
    });
  }
  return out;
}

export function problemIdAt(index: number): string {
  return `q${String(index + 1).padStart(3, '0')}`;
}

/** Claude の読み取り結果(1問)を、保存する形にする。図は範囲があれば切り出す。 */
export function toExtractedProblem(core: AppCore, paths: SourcePaths, p: ReadProblem, id: string): ExtractedProblem {
  const { figures, continuesFromPrevious: _c, ...rest } = p;
  return {
    ...rest,
    id,
    confirmed: false,
    figures: figures.map((f, i) => {
      const figId = `${id}-f${i + 1}`;
      return { ...f, id: figId, image: cropFigure(core, paths, f.page, f.bbox, figId) };
    }),
  };
}

/** 図を元ページから切り出して figures/ に保存する。できなければ null(画面はページ画像の一部を表示する)。 */
export function cropFigure(core: AppCore, paths: SourcePaths, page: number, bbox: { x: number; y: number; w: number; h: number }, figId: string): string | null {
  const src = paths.page(page);
  if (!core.cropImage || !existsSync(src) || bbox.w <= 0 || bbox.h <= 0) return null;
  const rel = `figures/${figId}-${Date.now().toString(36)}.png`;
  try {
    core.cropImage(src, bbox, `${paths.root}/${rel}`);
    return rel;
  } catch {
    return null;
  }
}

export function totalChars(problems: Array<{ body: string; choices: string[] }>): number {
  return problems.reduce((n, p) => n + p.body.length + p.choices.join('').length, 0);
}

const MODE_SECTION = /<!-- MODE:(\w+) -->\n([\s\S]*?)(?=<!-- MODE:|$)/g;

/** read_pages_modes.md から、問題用・答案用の指示を取り出す。 */
export function modeInstructions(mode: 'problems' | 'answers'): string {
  const text = loadPromptFile('read_pages_modes');
  for (const m of text.matchAll(MODE_SECTION)) {
    if (m[1] === mode) return m[2].trim();
  }
  throw new Error(`読み取りの指示(${mode})がありません`);
}

export function getExtracted(core: AppCore, projectId: string, subjectId: string, sourceId: string): Extracted | null {
  const paths = sourcePaths(core, projectId, subjectId, sourceId);
  return existsSync(paths.extractedJson) ? readData(paths.extractedJson, Files.extracted) : null;
}

/** 答案の読み取りのとき、対応付けの候補としてテストの設問を渡す。 */
export function testProblemsFor(core: AppCore, projectId: string, subjectId: string, meta: SourceMeta): Array<{ number: string; format: string; summary: string }> | null {
  if (meta.kind !== 'answer' || !meta.testId) return null;
  const tp = core.paths(projectId).subject(subjectId).test(meta.testId);
  if (!existsSync(tp.testJson)) return null;
  const test: Test = readData(tp.testJson, Files.test);
  return test.problems.map((p) => ({ number: p.number, format: p.format, summary: p.body.slice(0, 80) }));
}

/**
 * 資料のページ画像を Claude に読ませ、問題ごとの JSON(extracted.json)にする。
 * ページが多い資料は分けて読み、つなぎ目の問題をまたいで結合する。
 */
export async function readSource(core: AppCore, projectId: string, subjectId: string, sourceId: string, ctx: JobContext): Promise<Extracted> {
  const project = getProject(core, projectId);
  const subject = getSubject(project, subjectId);
  const paths = sourcePaths(core, projectId, subjectId, sourceId);
  const meta = readData(paths.sourceJson, Files.source);
  const pages = listPages(paths);
  if (pages.length === 0) throw new Error('この資料にはページ画像がありません');
  const mode = meta.kind === 'answer' ? 'answers' : 'problems';
  const units = leafUnits(getUnits(core, projectId, subjectId).tree).map((u) => ({ id: u.id, name: u.fullName }));
  const testProblems = testProblemsFor(core, projectId, subjectId, meta);

  const chunks = chunkPages(pages);
  const results: ReadProblem[][] = [];
  let madeBy: MadeBy | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    ctx.progress(chunks.length > 1 ? `ページ ${chunk[0]}〜${chunk[chunk.length - 1]} を読んでいます(${i + 1}/${chunks.length})` : 'ページを読んでいます');
    const prevAll = mergeChunks(results);
    const tail = prevAll[prevAll.length - 1];
    const r = await callClaude({
      projectDir: core.projectDir(projectId),
      kind: 'read_pages',
      vars: {
        modeLabel: mode === 'answers' ? '答案' : '問題',
        subjectName: subject.name,
        title: meta.title,
        kindLabel: SOURCE_KIND_LABEL[meta.kind],
        modeInstructions: modeInstructions(mode),
      },
      input: {
        mode,
        subject: subject.name,
        pages: chunk.map((n) => ({
          page: n,
          image: paths.pageRel(n),
          text: existsSync(paths.page(n).replace(/\.png$/, '.txt')) ? paths.pageRel(n).replace(/\.png$/, '.txt') : null,
        })),
        totalPages: pages.length,
        previousTail: tail ? { number: tail.number, bodyEnd: tail.body.slice(-400) } : null,
        units,
        testProblems,
      },
      schema: ReadPagesOutputSchema,
      env: core.claudeEnv(),
      signal: ctx.signal,
      check: (d) => {
        const bad = d.problems.flatMap((p) => [...p.pages, ...p.figures.map((f) => f.page)]).find((n) => !pages.includes(n));
        return bad === undefined ? null : `ページ ${bad} はこの資料にありません(pages と figures の page は、入力の pages にある番号だけを使う)`;
      },
    });
    results.push(r.data.problems);
    madeBy = r.madeBy;
  }

  const merged = mergeChunks(results);
  // 推定の単元は、一覧にある ID だけを残す
  const unitIds = new Set(units.map((u) => u.id));
  const problems = merged.map((p, i) => toExtractedProblem(core, paths, { ...p, unit: unitIds.has(p.unit) ? p.unit : '' }, problemIdAt(i)));
  const extracted: Extracted = { version: FORMAT_VERSION, sourceId, problems, readAt: new Date().toISOString(), confirmedAt: null, madeBy };
  writeData(paths.extractedJson, Files.extracted, extracted);
  // Claude が読んだままの内容を別に残す(補正率の計算と、補正の履歴のもと)
  writeData(paths.extractedOriginalJson, Files.extracted, extracted);
  writeData(paths.correctionsJson, Files.corrections, {
    version: FORMAT_VERSION,
    sourceId,
    entries: [],
    originalChars: totalChars(problems),
    changedChars: 0,
  });
  setSourceStatus(core, projectId, subjectId, sourceId, 'read');
  return extracted;
}
