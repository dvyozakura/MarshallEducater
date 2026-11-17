import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { safeFileName, writeFileAtomic } from '../../src/core/fsutil';
import { cleanupTmpFiles, DataFileError, Files, readData, readDataOr, writeData, type FileDef } from '../../src/core/store';
import { makeTmpDir } from './helpers';

const sampleProject = {
  version: 1,
  id: 'p1',
  name: 'テスト大学',
  university: 'テスト大学',
  faculty: '理学部',
  examDate: '2027-02-25',
  examType: 'kokkoritsu' as const,
  targetLevel: 'solid' as const,
  dailyMinutes: 180,
  subjects: [{ id: '数学', name: '数学' }],
  createdAt: '2026-11-17T00:00:00.000Z',
  updatedAt: '2026-11-17T00:00:00.000Z',
};

function expectDataError(fn: () => unknown, kind: string): DataFileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DataFileError);
    expect((e as DataFileError).kind).toBe(kind);
    return e as DataFileError;
  }
  throw new Error('エラーになるはず');
}

describe('検証つきの読み書き', () => {
  it('書いたものを読める。版番号が付く', () => {
    const f = join(makeTmpDir(), 'project.json');
    writeData(f, Files.project, { ...sampleProject, version: 0 });
    const p = readData(f, Files.project);
    expect(p).toEqual(sampleProject);
    expect(JSON.parse(readFileSync(f, 'utf8')).version).toBe(1);
  });

  it('形式に合わない内容は書かせない(元のファイルは変わらない)', () => {
    const f = join(makeTmpDir(), 'project.json');
    writeData(f, Files.project, sampleProject);
    expectDataError(() => writeData(f, Files.project, { ...sampleProject, examDate: '来年の春' }), 'invalid');
    expect(readData(f, Files.project).examDate).toBe('2027-02-25');
  });

  it('無いファイル: readData は missing、readDataOr は既定値', () => {
    const f = join(makeTmpDir(), 'none.json');
    expectDataError(() => readData(f, Files.project), 'missing');
    expect(readDataOr(f, Files.weakness, () => ({ version: 1, units: {}, updatedAt: null }))).toEqual({ version: 1, units: {}, updatedAt: null });
  });
});

describe('壊れたファイル', () => {
  it('JSON として読めない → corrupt(日本語の説明つき)', () => {
    const f = join(makeTmpDir(), 'project.json');
    writeFileSync(f, '{ "version": 1, "id": "p1", "na', 'utf8');
    const e = expectDataError(() => readData(f, Files.project), 'corrupt');
    expect(e.message).toContain('壊れていて読めません');
    // 壊れたファイルは消さない(人が直せるように残す)
    expect(existsSync(f)).toBe(true);
  });

  it('空のファイル・配列だけのファイル → corrupt', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'a.json'), '', 'utf8');
    writeFileSync(join(dir, 'b.json'), '[1,2]', 'utf8');
    expectDataError(() => readData(join(dir, 'a.json'), Files.project), 'corrupt');
    expectDataError(() => readData(join(dir, 'b.json'), Files.project), 'corrupt');
  });

  it('型に合わない → invalid(どの項目かが分かる)', () => {
    const f = join(makeTmpDir(), 'project.json');
    writeFileSync(f, JSON.stringify({ ...sampleProject, dailyMinutes: 'たくさん' }), 'utf8');
    const e = expectDataError(() => readData(f, Files.project), 'invalid');
    expect(e.detail).toContain('dailyMinutes');
  });

  it('BOM 付きでも読める', () => {
    const f = join(makeTmpDir(), 'project.json');
    writeFileSync(f, '﻿' + JSON.stringify(sampleProject), 'utf8');
    expect(readData(f, Files.project).id).toBe('p1');
  });
});

describe('版番号', () => {
  const V3: FileDef<{ version: number; title: string; tags: string[] }> = {
    name: 'demo.json',
    version: 3,
    schema: z.object({ version: z.number(), title: z.string(), tags: z.array(z.string()) }),
    migrations: {
      1: (raw) => ({ ...raw, title: raw.name, name: undefined }),
      2: (raw) => ({ ...raw, tags: [] }),
    },
  };

  it('古い版は順に直して読み、直した内容で書き戻す(元は .bak に残す)', () => {
    const f = join(makeTmpDir(), 'demo.json');
    writeFileSync(f, JSON.stringify({ version: 1, name: '古い形式' }), 'utf8');
    expect(readData(f, V3)).toEqual({ version: 3, title: '古い形式', tags: [] });
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ version: 3, title: '古い形式', tags: [] });
    expect(JSON.parse(readFileSync(`${f}.v1.bak`, 'utf8'))).toEqual({ version: 1, name: '古い形式' });
  });

  it('版番号が無いファイルは版 0 として扱い、足りない項目を既定値で補う', () => {
    const f = join(makeTmpDir(), 'project.json');
    const { version: _v, dailyMinutes: _d, ...old } = sampleProject;
    writeFileSync(f, JSON.stringify(old), 'utf8');
    const p = readData(f, Files.project);
    expect(p.version).toBe(1);
    expect(p.dailyMinutes).toBe(120);
  });

  it('直し方が無い古い版 → unsupported_version', () => {
    const f = join(makeTmpDir(), 'demo.json');
    writeFileSync(f, JSON.stringify({ version: 0, name: 'x' }), 'utf8');
    expectDataError(() => readData(f, V3), 'unsupported_version');
  });

  it('アプリより新しい版 → newer_version(書き換えない)', () => {
    const f = join(makeTmpDir(), 'project.json');
    const text = JSON.stringify({ ...sampleProject, version: 99, futureField: 1 });
    writeFileSync(f, text, 'utf8');
    const e = expectDataError(() => readData(f, Files.project), 'newer_version');
    expect(e.message).toContain('新しい版');
    expect(readFileSync(f, 'utf8')).toBe(text);
  });
});

describe('書き込み途中での中断', () => {
  it('置き換えの直前で落ちても、元のファイルは古い内容のまま読める', () => {
    const dir = makeTmpDir();
    const f = join(dir, 'project.json');
    writeData(f, Files.project, sampleProject);
    // 一時ファイルに途中まで書いた状態で落ちた、を再現する
    writeFileSync(`${f}.tmp-1234-abcd`, '{ "version": 1, "id": "p1", "name": "書きかけ', 'utf8');
    expect(readData(f, Files.project).name).toBe('テスト大学');
  });

  it('rename が失敗したら例外になり、元のファイルは変わらず、一時ファイルも残さない', () => {
    const dir = makeTmpDir();
    // 置き換え先が「中身のあるフォルダ」だと rename は必ず失敗する
    const f = join(dir, 'data.json');
    fs.mkdirSync(f);
    writeFileSync(join(f, 'inner.txt'), 'old', 'utf8');
    expect(() => writeFileAtomic(f, 'new')).toThrow();
    expect(readFileSync(join(f, 'inner.txt'), 'utf8')).toBe('old');
    expect(readdirSync(dir).filter((n) => n.includes('.tmp-'))).toHaveLength(0);
  });

  it('残った一時ファイルは片付けられる(書き込み中かもしれない新しいものは残す)', () => {
    const dir = makeTmpDir();
    const old = join(dir, 'sub');
    fs.mkdirSync(old);
    const stale = join(old, 'a.json.tmp-111-aaaa');
    const fresh = join(dir, 'b.json.tmp-222-bbbb');
    writeFileSync(stale, 'x');
    writeFileSync(fresh, 'y');
    writeFileSync(join(dir, 'keep.json'), '{}');
    const past = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(stale, past, past);
    expect(cleanupTmpFiles(dir)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(join(dir, 'keep.json'))).toBe(true);
  });
});

describe('ファイル名', () => {
  it('使えない文字を置き換える', () => {
    expect(safeFileName('数学II・B・C')).toBe('数学II・B・C');
    expect(safeFileName('a/b:c*d?')).toBe('a_b_c_d_');
    expect(safeFileName('con')).toBe('_con');
    expect(safeFileName('  ')).toBe('_');
    expect(safeFileName('末尾の点...')).toBe('末尾の点');
  });
});
