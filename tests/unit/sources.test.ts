import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sourcePaths } from '../../src/core/sources';
import { makeCore, sampleInput } from './helpers';

/** 中身は何でもよい、PNG の形をしたダミー。 */
export function fakePng(size = 200): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
}

describe('資料の取り込み(保存の側)', () => {
  it('開始 → ページ保存 → 完了で、一覧に出る。文字の層も保存される', () => {
    const t = makeCore();
    const p = t.api.createProject(sampleInput);
    const sid = p.subjects[0].id;
    const meta = t.api.importBegin(p.id, sid, { kind: 'past_exam', title: ' ダミー過去問 ', fileName: 'a.pdf' });
    expect(meta.title).toBe('ダミー過去問');
    // 途中(0ページ)のものは一覧に出さない
    expect(t.api.listSources(p.id, sid)).toHaveLength(0);
    t.api.importOriginal(p.id, sid, meta.id, new Uint8Array([37, 80, 68, 70]), 'original.pdf');
    t.api.importPage(p.id, sid, meta.id, 1, fakePng(), '第1問');
    t.api.importPage(p.id, sid, meta.id, 2, fakePng());
    const done = t.api.importFinish(p.id, sid, meta.id, 2);
    expect(done.pageCount).toBe(2);
    expect(done.status).toBe('imported');
    const paths = sourcePaths(t.core, p.id, sid, meta.id);
    expect(existsSync(paths.originalPdf)).toBe(true);
    expect(existsSync(paths.page(1).replace(/\.png$/, '.txt'))).toBe(true);
    expect(existsSync(paths.page(2).replace(/\.png$/, '.txt'))).toBe(false);
    expect(t.api.listSources(p.id, sid).map((s) => s.id)).toEqual([meta.id]);
    expect(t.api.readPageImage(p.id, sid, meta.id, 2).length).toBe(200);
    t.api.deleteSource(p.id, sid, meta.id);
    expect(t.api.listSources(p.id, sid)).toHaveLength(0);
    expect(existsSync(paths.root)).toBe(false);
  });

  it('おかしな入力は断る(PNG でない、ページ抜け、フォルダの外を指す名前)', () => {
    const t = makeCore();
    const p = t.api.createProject(sampleInput);
    const sid = p.subjects[0].id;
    const meta = t.api.importBegin(p.id, sid, { kind: 'workbook', title: '', fileName: 'b.pdf' });
    expect(meta.title).toBe('b.pdf');
    expect(() => t.api.importPage(p.id, sid, meta.id, 1, new Uint8Array(200))).toThrow('PNG');
    expect(() => t.api.importPage(p.id, sid, meta.id, 0, fakePng())).toThrow('ページ番号');
    expect(() => t.api.importOriginal(p.id, sid, meta.id, fakePng(), '../evil.pdf')).toThrow('名前');
    expect(() => t.api.importPage(p.id, sid, '../x', 1, fakePng())).toThrow('資料の指定');
    t.api.importPage(p.id, sid, meta.id, 1, fakePng());
    expect(() => t.api.importFinish(p.id, sid, meta.id, 2)).toThrow('ページ 2');
    expect(() => t.api.importFinish(p.id, sid, meta.id, 0)).toThrow('1枚も');
  });
});
