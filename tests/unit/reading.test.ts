import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildPrompt } from '../../src/core/claude/prompts';
import { chunkPages, mergeChunks, modeInstructions } from '../../src/core/reading';
import { sourcePaths } from '../../src/core/sources';
import { Files, readData } from '../../src/core/store';
import { ReadPagesOutputSchema, ReadProblemSchema, type ReadProblem } from '../../src/shared/schema';
import { done, importFake, makeCore, sampleInput, settled } from './helpers';

const rp = (o: Partial<ReadProblem> & { number: string; body: string }): ReadProblem => ReadProblemSchema.parse(o);

describe('読み取りのプロンプトと型', () => {
  it('問題用と答案用で指示が切り替わる。型の説明に必要な項目が入る', () => {
    const vars = { modeLabel: '問題', subjectName: '数学', title: 'ダミー', kindLabel: '過去問', modeInstructions: modeInstructions('problems') };
    const p = buildPrompt({ kind: 'read_pages', vars, inputFile: '.me/io/x/input.json', outputFile: '.me/io/x/output.json', schema: ReadPagesOutputSchema });
    expect(p).toContain('問題の書き起こし');
    expect(p).not.toContain('答案(受験生が書いた解答)の書き起こし');
    expect(p).toContain('ME_INPUT_FILE: .me/io/x/input.json');
    for (const key of ['"body"', '"choices"', '"answerFormat"', '"points"', '"figures"', '"bbox"', '"uncertain"', '"continuesFromPrevious"', '"unit"']) expect(p, key).toContain(key);
    expect(modeInstructions('answers')).toContain('testProblems');
  });

  it('型: 最小限の出力は既定値で補われ、誤った出力は断る', () => {
    const ok = ReadPagesOutputSchema.parse({ problems: [{ number: '1', body: '本文' }] });
    expect(ok.problems[0]).toMatchObject({ points: null, choices: [], answerFormat: 'other', figures: [], uncertain: [], continuesFromPrevious: false, target: null });
    expect(ReadPagesOutputSchema.safeParse({ problems: [{ number: '1' }] }).success).toBe(false);
    expect(ReadPagesOutputSchema.safeParse({ problems: [{ number: '1', body: 'x', figures: [{ page: 1, bbox: { x: 0, y: 0, w: 2, h: 1 }, description: '' }] }] }).success).toBe(false);
    expect(ReadPagesOutputSchema.safeParse({ problems: [{ number: '1', body: 'x', answerFormat: 'マーク' }] }).success).toBe(false);
    expect(z.toJSONSchema(ReadPagesOutputSchema)).toBeTruthy();
  });
});

describe('分けて読んだ結果の結合', () => {
  it('ページを決まった数ずつに分ける', () => {
    expect(chunkPages([1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9]]);
    expect(chunkPages([], 4)).toEqual([]);
  });

  it('つなぎ目の問題は、本文・ページ・図・選択肢・自信のない箇所をつなげて1問にする', () => {
    const merged = mergeChunks([
      [rp({ number: '1', body: 'A' }), rp({ number: '2', body: '前半', pages: [4], uncertain: [{ text: '前', reason: 'r1' }], choices: ['ア'] })],
      [
        rp({ number: '2', body: '後半', pages: [5], points: 20, continuesFromPrevious: true, choices: ['イ'], uncertain: [{ text: '後', reason: 'r2' }], figures: [{ page: 5, bbox: { x: 0, y: 0, w: 1, h: 1 }, description: '図' }] }),
        rp({ number: '3', body: 'C', pages: [5] }),
      ],
    ]);
    expect(merged.map((p) => p.number)).toEqual(['1', '2', '3']);
    expect(merged[1]).toMatchObject({ body: '前半\n後半', pages: [4, 5], points: 20, choices: ['ア', 'イ'], continuesFromPrevious: false });
    expect(merged[1].uncertain).toHaveLength(2);
    expect(merged[1].figures).toHaveLength(1);
  });

  it('3つのページ群にまたがる問題も1問になる。先頭のページ群の「続き」印は無視する', () => {
    const merged = mergeChunks([
      [rp({ number: '1', body: 'a', continuesFromPrevious: true })],
      [rp({ number: '1', body: 'b', continuesFromPrevious: true })],
      [],
      [rp({ number: '1', body: 'c', continuesFromPrevious: true }), rp({ number: '2', body: 'd', continuesFromPrevious: true })],
    ]);
    expect(merged.map((p) => p.body)).toEqual(['a\nb\nc', 'd']);
  });
});

describe('Claude による読み取り(偽 Claude での一連の流れ)', () => {
  it('6ページの資料を2回に分けて読み、つなぎ目を結合して保存する', async () => {
    const t = makeCore();
    const p = t.api.createProject(sampleInput);
    const sid = p.subjects[0].id;
    const sourceId = importFake(t, p.id, sid, 6);
    expect(t.api.getExtracted(p.id, sid, sourceId)).toBeNull();
    const job = await done(t, t.api.startReadSource(p.id, sid, sourceId));
    expect(job.title).toContain('「ダミー資料」の読み取り');

    // 呼び出しは2回(1〜4ページ、5〜6ページ)。2回目には前の最後の問題が渡る
    const calls = t.fake.calls();
    expect(calls.map((c) => c.kind)).toEqual(['read_pages', 'read_pages']);
    expect(calls[0].prompt).toContain('問題の書き起こし');

    const ex = t.api.getExtracted(p.id, sid, sourceId)!;
    // 4ページ×2問 = 8問。5ページ目の先頭は8問目の続きとして結合、残り3問 → 11問
    expect(ex.problems).toHaveLength(11);
    expect(ex.problems.map((q) => q.id)).toEqual(['q001', 'q002', 'q003', 'q004', 'q005', 'q006', 'q007', 'q008', 'q009', 'q010', 'q011']);
    const joined = ex.problems[7];
    expect(joined.number).toBe('第4問 (2)');
    expect(joined.pages).toEqual([4, 5]);
    expect(joined.body).toContain('ページ 4 の2つ目の問題');
    expect(joined.body).toContain('(続き)');
    expect(ex.problems[8].number).toBe('第5問 (2)');
    expect(ex.confirmedAt).toBeNull();
    expect(ex.problems.every((q) => q.confirmed === false)).toBe(true);

    // 内容: 番号・配点・選択肢・解答欄の形式・推定単元・自信がない箇所
    expect(ex.problems[0]).toMatchObject({ major: '第1問', minor: '(1)', points: 10, answerFormat: 'short', unit: 'u01-01' });
    expect(ex.problems[1].choices).toHaveLength(4);
    expect(ex.problems[1].answerFormat).toBe('choice');
    expect(ex.problems[1].uncertain[0].reason).toContain('かすれて');

    // 図は切り出して保存され、説明が付く
    const paths = sourcePaths(t.core, p.id, sid, sourceId);
    const fig = ex.problems[0].figures[0];
    expect(fig.id).toBe('q001-f1');
    expect(fig.description).toContain('直角三角形');
    expect(fig.image).toMatch(/^figures\/q001-f1-.*\.png$/);
    expect(existsSync(join(paths.root, fig.image!))).toBe(true);

    // 資料の状態、Claude が読んだままの控え、補正の履歴の初期化
    expect(t.api.getSource(p.id, sid, sourceId).status).toBe('read');
    expect(readData(paths.extractedOriginalJson, Files.extracted).problems).toHaveLength(11);
    const corr = readData(paths.correctionsJson, Files.corrections);
    expect(corr.entries).toEqual([]);
    expect(corr.originalChars).toBeGreaterThan(100);
  });

  it('入力ファイルに、ページ画像のパス・文字の層・単元の一覧が渡る', async () => {
    const t = makeCore({ kinds: { read_pages: ['bad_page', 'ok'] } });
    const p = t.api.createProject(sampleInput);
    const sid = p.subjects[0].id;
    const sourceId = importFake(t, p.id, sid, 1);
    await done(t, t.api.startReadSource(p.id, sid, sourceId));
    // 1回目は、資料に無いページ番号を返したのでやり直しになった
    const calls = t.fake.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain('ページ 999 はこの資料にありません');
    const logs = t.core.paths(p.id).logsDir;
    expect(existsSync(logs)).toBe(true);
  });

  it('途中で失敗したら、資料は「未読み取り」のまま(中途半端な結果を残さない)', async () => {
    const t = makeCore({ kinds: { read_pages: ['ok', 'usage_limit'] } });
    const p = t.api.createProject(sampleInput);
    const sid = p.subjects[0].id;
    const sourceId = importFake(t, p.id, sid, 6);
    const job = await settled(t, t.api.startReadSource(p.id, sid, sourceId));
    expect(job.status).toBe('failed');
    expect(job.error?.kind).toBe('usage_limit');
    expect(t.api.getExtracted(p.id, sid, sourceId)).toBeNull();
    expect(t.api.getSource(p.id, sid, sourceId).status).toBe('imported');
  });
});
