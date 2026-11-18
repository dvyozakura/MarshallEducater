import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FORMAT_VERSION, SourceKindSchema, type SourceKind, type SourceMeta } from '../shared/schema';
import type { AppCore } from './app';
import { ensureDir, newId, writeFileAtomic } from './fsutil';
import type { SourcePaths } from './paths';
import { Files, readData, writeData } from './store';

/** 紙の答案は、テストのフォルダの submission/ に資料と同じ構成で置く。その資料 ID の付け方。 */
export const SUBMISSION_PREFIX = 'sub-';
export function submissionSourceId(testId: string): string {
  return `${SUBMISSION_PREFIX}${testId}`;
}
export function testIdOfSubmission(sourceId: string): string | null {
  return sourceId.startsWith(SUBMISSION_PREFIX) ? sourceId.slice(SUBMISSION_PREFIX.length) : null;
}

function checkId(id: string): void {
  if (!id || /[\\/]|^\.+$/.test(id)) throw new Error('資料の指定が正しくありません');
}

export function sourcePaths(core: AppCore, projectId: string, subjectId: string, sourceId: string): SourcePaths {
  checkId(subjectId);
  checkId(sourceId);
  const sp = core.paths(projectId).subject(subjectId);
  const testId = testIdOfSubmission(sourceId);
  return testId ? sp.test(testId).submission : sp.source(sourceId);
}

export interface ImportBegin {
  kind: SourceKind;
  title: string;
  fileName: string;
  /** 答案の場合: どのテストへの答案か。 */
  testId?: string | null;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function assertPng(bytes: Uint8Array): void {
  if (bytes.length < 100 || PNG_MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('ページ画像が PNG ではありません');
}

/** 取り込みの開始: 資料フォルダを作る。ページ画像はこのあと1枚ずつ届く。 */
export function importBegin(core: AppCore, projectId: string, subjectId: string, info: ImportBegin): SourceMeta {
  const kind = SourceKindSchema.parse(info.kind);
  const title = info.title.trim() || info.fileName || '無題の資料';
  let id: string;
  if (kind === 'answer' && info.testId) {
    id = submissionSourceId(info.testId);
    const tp = core.paths(projectId).subject(subjectId).test(info.testId);
    if (!existsSync(tp.testJson)) throw new Error('答案を出す先のテストが見つかりません');
    if (readData(tp.testJson, Files.test).status === 'graded') throw new Error('このテストは採点済みです。答案の出し直しはできません。');
    // 出し直しのときは、前の答案を消してから入れ直す
    rmSync(tp.submission.root, { recursive: true, force: true });
  } else {
    id = newId('src');
  }
  const paths = sourcePaths(core, projectId, subjectId, id);
  ensureDir(paths.pagesDir);
  return writeData(paths.sourceJson, Files.source, {
    version: FORMAT_VERSION,
    id,
    kind,
    title,
    fileName: info.fileName,
    pageCount: 0,
    importedAt: new Date().toISOString(),
    status: 'imported',
    testId: info.testId ?? null,
  });
}

/** 元のファイルを保存する(PDF は original.pdf、画像は original-<n>.<拡張子>)。 */
export function importOriginal(core: AppCore, projectId: string, subjectId: string, sourceId: string, bytes: Uint8Array, name: string): void {
  const paths = sourcePaths(core, projectId, subjectId, sourceId);
  if (!existsSync(paths.sourceJson)) throw new Error('取り込み中の資料が見つかりません');
  if (!/^original(-\d+)?\.(pdf|png|jpg|jpeg)$/i.test(name)) throw new Error('元ファイルの名前が正しくありません');
  writeFileAtomic(join(paths.root, name.toLowerCase()), bytes);
}

/** ページ画像(PNG)を1枚保存する。文字の層があれば text も保存する(読み取りの助けにする)。 */
export function importPage(core: AppCore, projectId: string, subjectId: string, sourceId: string, pageNo: number, png: Uint8Array, text?: string): void {
  const paths = sourcePaths(core, projectId, subjectId, sourceId);
  if (!existsSync(paths.sourceJson)) throw new Error('取り込み中の資料が見つかりません');
  if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > 2000) throw new Error('ページ番号が正しくありません');
  assertPng(png);
  writeFileAtomic(paths.page(pageNo), png);
  if (text && text.trim()) writeFileAtomic(paths.page(pageNo).replace(/\.png$/, '.txt'), text);
}

/** 取り込みの完了: ページ数を確かめて記録する。 */
export function importFinish(core: AppCore, projectId: string, subjectId: string, sourceId: string, pageCount: number): SourceMeta {
  const paths = sourcePaths(core, projectId, subjectId, sourceId);
  const meta = readData(paths.sourceJson, Files.source);
  if (pageCount < 1) throw new Error('ページが1枚もありません');
  for (let n = 1; n <= pageCount; n++) {
    if (!existsSync(paths.page(n))) throw new Error(`ページ ${n} の画像が保存されていません`);
  }
  const done = writeData(paths.sourceJson, Files.source, { ...meta, pageCount });
  // 紙の答案を出した: テストは「答案の読み取り・補正中」になる。前に出した答案(アプリ内の入力を含む)は使わない
  const testId = testIdOfSubmission(sourceId);
  if (testId) {
    const tp = core.paths(projectId).subject(subjectId).test(testId);
    rmSync(tp.readingJson, { force: true });
    rmSync(tp.draftJson, { force: true });
    const test = readData(tp.testJson, Files.test);
    writeData(tp.testJson, Files.test, { ...test, status: 'reading' });
  }
  return done;
}

export function getSource(core: AppCore, projectId: string, subjectId: string, sourceId: string): SourceMeta {
  return readData(sourcePaths(core, projectId, subjectId, sourceId).sourceJson, Files.source);
}

export function setSourceStatus(core: AppCore, projectId: string, subjectId: string, sourceId: string, status: SourceMeta['status']): SourceMeta {
  const paths = sourcePaths(core, projectId, subjectId, sourceId);
  const meta = readData(paths.sourceJson, Files.source);
  return writeData(paths.sourceJson, Files.source, { ...meta, status });
}

/** 科目の資料の一覧(答案は含めない。答案はテスト側から見る)。取り込みが途中のもの(0ページ)は出さない。 */
export function listSources(core: AppCore, projectId: string, subjectId: string): SourceMeta[] {
  const dir = core.paths(projectId).subject(subjectId).sourcesDir;
  if (!existsSync(dir)) return [];
  const out: SourceMeta[] = [];
  for (const name of readdirSync(dir)) {
    const f = join(dir, name, 'source.json');
    if (!existsSync(f)) continue;
    try {
      const meta = readData(f, Files.source);
      if (meta.pageCount > 0) out.push(meta);
    } catch {
      /* 壊れた資料は一覧に出さない */
    }
  }
  return out.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

export function deleteSource(core: AppCore, projectId: string, subjectId: string, sourceId: string): void {
  const paths = sourcePaths(core, projectId, subjectId, sourceId);
  if (!existsSync(paths.sourceJson)) return;
  rmSync(paths.root, { recursive: true, force: true });
  // 紙の答案を取り消したら、テストは「未提出」に戻す
  const testId = testIdOfSubmission(sourceId);
  if (testId) {
    const tp = core.paths(projectId).subject(subjectId).test(testId);
    if (existsSync(tp.testJson)) {
      const test = readData(tp.testJson, Files.test);
      if (test.status === 'reading') writeData(tp.testJson, Files.test, { ...test, status: 'ready' });
    }
  }
}

/** ページ画像(PNG)の中身を返す(画面での表示用)。 */
export function readPageImage(core: AppCore, projectId: string, subjectId: string, sourceId: string, pageNo: number): Uint8Array {
  const file = sourcePaths(core, projectId, subjectId, sourceId).page(pageNo);
  if (!existsSync(file)) throw new Error(`ページ ${pageNo} の画像がありません`);
  return readFileSync(file);
}

/** 取り込み済みのページ番号の一覧。 */
export function listPages(paths: SourcePaths): number[] {
  if (!existsSync(paths.pagesDir)) return [];
  return readdirSync(paths.pagesDir)
    .map((n) => n.match(/^page-(\d+)\.png$/))
    .filter((m): m is RegExpMatchArray => !!m && statSync(join(paths.pagesDir, m[0])).size > 0)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}
