import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPrompt } from '../../src/core/claude/prompts';
import { Files, readData } from '../../src/core/store';
import { getChapter, getChapterReview, textbookPaths } from '../../src/core/textbook';
import { CHAPTER_CALLS_ESTIMATE, chapterMarkdown } from '../../src/core/textbook_build';
import { ChapterBodyOutputSchema, ChapterReviewOutputSchema, ChapterReviseOutputSchema, ChapterSupplementOutputSchema } from '../../src/shared/schema';
import { done, makeCore, sampleInput, settled, setupTest, submitAndGrade, type TestCore } from './helpers';

function setup(control: Record<string, unknown> = {}) {
  const t = makeCore(control);
  const p = t.api.createProject(sampleInput);
  const sid = p.subjects[0].id;
  const chapters = t.api.getTextbookView(p.id, sid).chapters;
  return { t, p, sid, chapters, u: chapters.map((c) => c.unitId) };
}
const kinds = (t: TestCore) => t.fake.calls().map((c) => c.kind);
const inputOf = (t: TestCore, kind: string, n = -1) => {
  const call = t.fake.calls().filter((c) => c.kind === kind).at(n)!;
  return call.prompt;
};

afterEach(() => {
  delete process.env.ME_TODAY;
});

describe('教材のプロンプトと型', () => {
  it('本文: 章の構成・厚さ・未習・前後の章・傾向を渡し、導入・要点・よくある誤り・例題のねらいを書かせる', () => {
    const p = buildPrompt({ kind: 'chapter_body', vars: { subjectName: '数学', chapterNo: '3', unitName: '漸化式' }, inputFile: 'in.json', outputFile: 'out.json', schema: ChapterBodyOutputSchema });
    for (const w of ['第3章「漸化式」', '導入 → 要点 → 例題', '`spec`', '`unlearned`', '`weakness`', '`trend`', '`previousChapter`', '`nextChapter`', '"intro"', '"points"', '"pitfalls"', '"exampleFocus"', '[[fig1]]', '正確さを最優先', 'ME_PROMPT_KIND: chapter_body'])
      expect(p, w).toContain(w);
    expect(ChapterBodyOutputSchema.safeParse({ intro: 'a', points: '', pitfalls: 'c' }).success).toBe(false);
    expect(ChapterBodyOutputSchema.parse({ intro: 'a', points: 'b', pitfalls: 'c' })).toMatchObject({ exampleFocus: [], figures: [] });
  });
  it('点検: 事実・計算・用語を別の担当として見る。誤りが無ければ指摘は空', () => {
    const p = buildPrompt({ kind: 'chapter_review', vars: { subjectName: '数学', chapterTitle: '第3章 数列 > 漸化式' }, inputFile: 'in.json', outputFile: 'out.json', schema: ChapterReviewOutputSchema });
    for (const w of ['別の担当', '**事実**', '**計算**', '**用語**', '`issues` は空の配列', '"quote"', '"fix"', '第3章 数列 > 漸化式']) expect(p, w).toContain(w);
    expect(ChapterReviewOutputSchema.safeParse({ issues: [{ section: 'examples', problem: 'x' }] }).success).toBe(false);
    expect(ChapterReviewOutputSchema.parse({ issues: [] }).comment).toBe('');
  });
  it('修正・補足', () => {
    const r = buildPrompt({ kind: 'chapter_revise', vars: { subjectName: '数学', chapterTitle: 'x' }, inputFile: 'in.json', outputFile: 'out.json', schema: ChapterReviseOutputSchema });
    for (const w of ['`issues`', '指摘の無い箇所は、**書き換えない**', '**全文**']) expect(r, w).toContain(w);
    const s = buildPrompt({ kind: 'chapter_supplement', vars: { subjectName: '数学', chapterTitle: 'x' }, inputFile: 'in.json', outputFile: 'out.json', schema: ChapterSupplementOutputSchema });
    for (const w of ['`conversation`', '補足', '"title"', '"markdown"']) expect(s, w).toContain(w);
  });
});

describe('章の生成と点検(偽 Claude)', () => {
  it('生成 → 検算 → 点検で指摘なし → 完成。章(.json と .md)・確認問題のテスト・点検結果・目次が保存される', async () => {
    const { t, p, sid, u, chapters } = setup();
    const job = await done(t, t.api.startCreateChapter(p.id, sid, u[1]));
    expect(job.title).toContain(`教材 第2章「${chapters[1].name}」`);
    expect(job.result).toMatchObject({ unitId: u[1], chapterVersion: 1, examples: 2, quiz: 3, issues: 0, revised: false });
    // 呼び出し: 本文 → 問題づくり → 解き直し → 照らし合わせ(記述の確認問題)→ 点検(指摘が無いので、修正は呼ばない)。目安の 5 回
    expect(kinds(t)).toEqual(['chapter_body', 'generate_problems', 'solve_problems', 'judge_answers', 'chapter_review']);
    expect(kinds(t)).toHaveLength(CHAPTER_CALLS_ESTIMATE);

    const ch = getChapter(t.core, p.id, sid, u[1])!;
    expect(ch).toMatchObject({ unitId: u[1], title: chapters[1].title, chapterVersion: 1, thickness: 'standard', unlearned: false, masteryAtBuild: null, supplements: [] });
    expect(ch.intro).toContain(`第2章では「${chapters[1].name}」を学びます(テスト大学 理学部 向け・厚さ: standard)`);
    expect(ch.intro).toContain(`前の章「${chapters[0].title}」の続きです`);
    expect(ch.intro).toContain(`次の章は「${chapters[2].title}」です`);
    expect(ch.points).toContain('$a^2 + b^2 = c^2$');
    expect(ch.points).toContain('教科書の標準的な詳しさ');
    // 例題は解答・解説つき。ねらいが問題づくりに渡っている
    expect(ch.examples.map((e) => [e.difficulty, e.format])).toEqual([['easy', 'short'], ['standard', 'short']]);
    expect(ch.examples[0]).toMatchObject({ focus: '例題1(easy)のねらい', answer: '$20$' });
    expect(ch.examples[0].body).toContain('教材の例題');
    expect(ch.examples[0].solution).toContain('足すと');
    const genPrompt = t.fake.calls().find((c) => c.kind === 'generate_problems')!.prompt;
    expect(genPrompt).toContain('教材 第2章');
    // 確認問題は、既存の「テスト」として保存される(答えは answer_key.json。章には問題文だけ)
    expect(ch.quiz.map((q) => q.difficulty)).toEqual(['easy', 'standard', 'target']);
    expect(JSON.stringify(ch.quiz)).not.toContain('answer');
    const quiz = t.api.getTest(p.id, sid, ch.quizTestId!);
    expect(quiz).toMatchObject({ kind: 'practice', chapterUnitId: u[1], status: 'ready', timeLimitMin: 24 });
    expect(quiz.title).toBe(`第2章「${chapters[1].name}」の確認問題`);
    expect(quiz.problems.map((q) => q.origin)).toEqual(['textbook', 'textbook', 'textbook']);
    expect(quiz.problems[2].format).toBe('essay'); // 国公立二次の目標校レベルは記述
    expect(t.api.getVerify(p.id, sid, quiz.id)!.counts).toEqual({ adopted: 3, regenerated: 0, discarded: 0 });

    // 人が読む版: 導入 → 要点 → 例題 → よくある誤り → 確認問題
    const tb = textbookPaths(t.core, p.id, sid);
    const md = readFileSync(tb.chapterMd(u[1]), 'utf8');
    const order = [`# 第2章 ${chapters[1].name}`, '## 導入', '## 要点', '## 例題', '### 例題1(易・短答)', '**解答** $20$', '**解説**', '## よくある誤り', '## 確認問題'].map((w) => md.indexOf(w));
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(md).toBe(chapterMarkdown(ch, 2));

    // 点検結果(review/)と目次
    const review = getChapterReview(t.core, p.id, sid, u[1])!;
    expect(review.records).toHaveLength(1);
    expect(review.records[0]).toMatchObject({ chapterVersion: 1, target: 'chapter', issues: [], revised: false, verify: { adopted: 2, regenerated: 0, discarded: 0 } });
    expect(review.records[0].comment).toContain('例題 2 題と照合');
    const row = t.api.getTextbookView(p.id, sid).chapters[1];
    expect(row).toMatchObject({ status: 'done', chapterVersion: 1, thickness: 'standard', masteryAtBuild: null, unlearnedAtBuild: false, quizTestId: quiz.id, read: false, job: null });
    expect(row.quiz).toEqual({ testId: quiz.id, status: 'ready', total: 3, correct: null });
    expect(t.api.getTextbookView(p.id, sid).counts).toMatchObject({ done: 1 });
    // 点検の入力には、本文と(検算済みの)例題が渡る。解き直しには答えを渡さない
    expect(inputOf(t, 'chapter_review')).toContain(`第2章 ${chapters[1].title}`);
  });

  it('点検で指摘あり → 1回だけ直してから完成。指摘と修正は review/ に残る。直さない出力はやり直させる', async () => {
    const { t, p, sid, u } = setup({ kinds: { chapter_review: ['issues'], chapter_revise: ['partial', 'ok'] } });
    const job = await done(t, t.api.startCreateChapter(p.id, sid, u[0]));
    expect(job.result).toMatchObject({ issues: 1, revised: true });
    expect(kinds(t)).toEqual(['chapter_body', 'generate_problems', 'solve_problems', 'judge_answers', 'chapter_review', 'chapter_revise', 'chapter_revise']);
    expect(inputOf(t, 'chapter_revise')).toContain('指摘のあった部分 points の、直したあとの全文がありません');
    const ch = getChapter(t.core, p.id, sid, u[0])!;
    expect(ch.points).toContain('(点検の指摘 1 件を反映して直しました)');
    expect(ch.intro).not.toContain('反映して直しました'); // 指摘の無い部分は、そのまま
    expect(ch.pitfalls).not.toContain('反映して直しました');
    const rec = getChapterReview(t.core, p.id, sid, u[0])!.records[0];
    expect(rec).toMatchObject({ revised: true, comment: '計算の誤りが1件' });
    expect(rec.issues).toEqual([expect.objectContaining({ section: 'points', problem: '計算の誤り: 式の値が合わない', fix: '正しい値に直す' })]);
    // 直したあとの再点検はしない(点検は1回)
    expect(kinds(t).filter((k) => k === 'chapter_review')).toHaveLength(1);

    // 2つの部分に指摘 → どちらも直る
    t.fake.set({ kinds: { chapter_review: ['issues2'] } });
    await done(t, t.api.startCreateChapter(p.id, sid, u[1]));
    const ch2 = getChapter(t.core, p.id, sid, u[1])!;
    expect(ch2.intro).toContain('反映して直しました');
    expect(ch2.pitfalls).toContain('反映して直しました');
    expect(ch2.points).not.toContain('反映して直しました');
    // 設定の「品質」欄に数が出る
    expect(t.api.getQuality().textbook).toEqual({ chapters: 2, reviews: 2, withIssues: 2, issues: 3, revised: 2 });
  });

  it('検算で問題を差し替え: 合わない例題は作り直し、それでも駄目なら捨てて別の問題にする。結果は記録される', async () => {
    // 1回目の解き直し: 1問目(例題1)と3問目(確認問題1)が不一致 → 作り直し。2回目: 1問目(例題1)だけまだ不一致 → 破棄して代わりを作る
    const { t, p, sid, u } = setup({ kinds: { solve_problems: ['wrong:1,3', 'wrong:1', 'ok'] } });
    const job = await done(t, t.api.startCreateChapter(p.id, sid, u[0]));
    expect(job.result).toMatchObject({ examples: 2, quiz: 3, verify: { adopted: 4, regenerated: 1, discarded: 1 } });
    expect(kinds(t)).toEqual(['chapter_body', 'generate_problems', 'solve_problems', 'judge_answers', 'generate_problems', 'solve_problems', 'judge_answers', 'generate_problems', 'solve_problems', 'chapter_review']);
    const ch = getChapter(t.core, p.id, sid, u[0])!;
    expect(ch.examples).toHaveLength(2);
    expect(ch.examples[0].body).toContain('$13 + 7$'); // 捨てた問題の代わり(作り直しの 113 ではない、別の問題)
    // 例題の検算は点検結果に、確認問題の検算はテストに残る
    expect(getChapterReview(t.core, p.id, sid, u[0])!.records[0].verify).toEqual({ adopted: 2, regenerated: 0, discarded: 1 });
    expect(t.api.getVerify(p.id, sid, ch.quizTestId!)!.counts).toEqual({ adopted: 2, regenerated: 1, discarded: 0 });
    expect(t.api.getQuality().verify).toMatchObject({ tests: 1, adopted: 4, regenerated: 1, discarded: 1, total: 6 });

    // 例題が1つも検算に通らなければ、章は作らない(目次は未作成のまま)
    t.fake.set({ kinds: { solve_problems: 'wrong' } });
    const failed = await settled(t, t.api.startCreateChapter(p.id, sid, u[1]));
    expect(failed.status).toBe('failed');
    expect(failed.error?.message).toContain('検算に通る例題を1つも作れませんでした');
    expect(getChapter(t.core, p.id, sid, u[1])).toBeNull();
    expect(t.api.getTextbookView(p.id, sid).chapters[1]).toMatchObject({ status: 'none', job: null });
  });

  it('厚さは習熟度で変わる。未習は前提から。苦手の記録・傾向・授業ノートを渡す', async () => {
    const { t, p, sid, ids, test } = await setupTest();
    await submitAndGrade(t, ids, { p01: '2', p02: '99' }); // p01 は正解、p02 は誤答
    const weak = test.problems[1].unitId;
    const strongJob = t.api.getTextbookView(p.id, sid).chapters.find((c) => c.unitId === weak)!;
    expect(strongJob.plannedThickness).toBe('thick');
    await done(t, t.api.startCreateNote(p.id, sid, weak));
    const r = (await done(t, t.api.startCreateChapter(p.id, sid, weak))).result as { examples: number; quiz: number };
    expect([r.examples, r.quiz]).toEqual([4, 4]);
    const ch = getChapter(t.core, p.id, sid, weak)!;
    expect(ch.thickness).toBe('thick');
    expect(ch.masteryAtBuild).toBeLessThan(45);
    expect(ch.points).toContain('この単元は苦手');
    expect(ch.points).toContain('授業ノートの内容を踏まえています');
    expect(ch.pitfalls).toContain('間違えた問題 1 件を踏まえた注意');
    expect(t.api.getTextbookView(p.id, sid).chapters.find((c) => c.unitId === weak)).toMatchObject({ status: 'done', staleReason: '', hasNote: true });

    // 未習の印を付けた単元(記録なし)は、詳しく・前提から
    const other = t.api.getTextbookView(p.id, sid).chapters.find((c) => c.mastery === null)!.unitId;
    t.api.setChapterUnlearned(p.id, sid, other, true);
    await done(t, t.api.startCreateChapter(p.id, sid, other));
    const un = getChapter(t.core, p.id, sid, other)!;
    expect(un).toMatchObject({ thickness: 'thick', unlearned: true });
    expect(un.points).toContain('未習の単元として、前提の確認から');
    expect(un.examples.map((e) => e.difficulty)).toEqual(['easy', 'easy', 'standard', 'standard']);
    // 印を外すと「作り直しを提案」
    t.api.setChapterUnlearned(p.id, sid, other, false);
    expect(t.api.getTextbookView(p.id, sid).chapters.find((c) => c.unitId === other)).toMatchObject({ status: 'stale', staleReason: expect.stringContaining('未習') });
  });

  it('作り直すと、前の版が versions/ に残る。既読の印と補足は引き継ぐ。崩れた図は捨てる', async () => {
    const { t, p, sid, u } = setup({ kinds: { chapter_body: ['with_figure', 'bad_figure'] } });
    await done(t, t.api.startCreateChapter(p.id, sid, u[0]));
    const v1 = getChapter(t.core, p.id, sid, u[0])!;
    expect(v1.figures).toEqual([expect.objectContaining({ id: 'fig1', caption: '直角三角形の図' })]);
    expect(v1.points).toContain('[[fig1]]');
    const tb = textbookPaths(t.core, p.id, sid);
    expect(readFileSync(tb.chapterMd(u[0]), 'utf8')).toContain('(図: 直角三角形の図)');
    t.api.setChapterRead(p.id, sid, u[0], true);
    expect(existsSync(tb.versionJson(u[0], 1))).toBe(false);

    const job = await done(t, t.api.startCreateChapter(p.id, sid, u[0]));
    expect(job.result).toMatchObject({ chapterVersion: 2 });
    const v2 = getChapter(t.core, p.id, sid, u[0])!;
    expect(v2.chapterVersion).toBe(2);
    expect(v2.intro).toContain('作り直し');
    expect(v2.createdAt).toBe(v1.createdAt);
    expect(v2.figures).toEqual([]); // スクリプト入りの図は使わない
    // 前の版
    expect(readData(tb.versionJson(u[0], 1), Files.chapter)).toEqual(v1);
    expect(readFileSync(tb.versionMd(u[0], 1), 'utf8')).toContain('第 1 版');
    expect(readFileSync(tb.chapterMd(u[0]), 'utf8')).toContain('第 2 版');
    // 確認問題のテストは新しくなる(前のテストも履歴に残る)
    expect(v2.quizTestId).not.toBe(v1.quizTestId);
    expect(t.api.getTest(p.id, sid, v2.quizTestId!).title).toContain('(第 2 版)');
    expect(t.api.listTests(p.id, sid)).toHaveLength(2);
    expect(t.api.getTextbookView(p.id, sid).chapters[0]).toMatchObject({ chapterVersion: 2, read: true, status: 'done' });
    expect(getChapterReview(t.core, p.id, sid, u[0])!.records.map((r) => r.chapterVersion)).toEqual([1, 2]);
  });

  it('作っている間は「作成中」。同じ章を二重には作らない。失敗したら前の状態に戻る', async () => {
    const { t, p, sid, u } = setup({ kinds: { chapter_body: ['slow'] }, slowMs: 600 });
    const job = t.api.startCreateChapter(p.id, sid, u[0]);
    expect(t.api.startCreateChapter(p.id, sid, u[0]).id).toBe(job.id);
    await new Promise((r) => setTimeout(r, 150));
    const row = t.api.getTextbookView(p.id, sid).chapters[0];
    expect(row.status).toBe('generating');
    expect(row.job).toMatchObject({ id: job.id, status: 'running' });
    expect(row.job!.progress).toContain('本文を書いています');
    expect(readData(textbookPaths(t.core, p.id, sid).tocJson, Files.toc).chapters[0].status).toBe('generating');
    await done(t, job);
    expect(t.api.getTextbookView(p.id, sid).chapters[0]).toMatchObject({ status: 'done', job: null });

    t.fake.set({ kinds: { chapter_review: 'usage_limit' } });
    const failed = await settled(t, t.api.startCreateChapter(p.id, sid, u[0]));
    expect(failed.error?.kind).toBe('usage_limit');
    expect(t.api.getTextbookView(p.id, sid).chapters[0]).toMatchObject({ status: 'done', chapterVersion: 1 }); // 前の版のまま
    expect((await settled(t, t.api.startCreateChapter(p.id, sid, 'zzz'))).error?.message).toContain('単元ツリー');
  });
});

describe('まとめて作る', () => {
  it('始める前に、呼び出しの見込み数を出す。未作成の章だけを順にジョブへ入れる', async () => {
    const { t, p, sid, u } = setup();
    t.api.updateSettings({ dailyLimit: 1000 });
    await done(t, t.api.startCreateChapter(p.id, sid, u[0]));
    const plan = t.api.planBuildAll(p.id, sid);
    expect(plan.targets.map((x) => x.unitId)).toEqual(u.slice(1));
    expect(plan.targets[0].no).toBe(2);
    expect(plan).toMatchObject({ perChapter: CHAPTER_CALLS_ESTIMATE, estimateCalls: (u.length - 1) * CHAPTER_CALLS_ESTIMATE, used: 5, limit: 1000, later: [] });
    expect(plan.maxCalls).toBeGreaterThan(plan.estimateCalls);
    expect(plan.today).toEqual(u.slice(1)); // 上限に余裕があるので、今日すべて
    // 見込みを見るだけでは、何も始まらない
    expect(t.api.listJobs().filter((j) => j.status === 'queued' || j.status === 'running')).toHaveLength(0);
  });

  it('1日の上限をまたぐ: 今日の残りで作れる章だけ並べ、残りは翌日に回す。翌日、続きから自動で並ぶ', async () => {
    process.env.ME_TODAY = '2026-12-01';
    const { t, p, sid, u } = setup();
    // 残り 12 回 → 目安 5 回/章 なので、今日は 2 章
    t.api.updateSettings({ dailyLimit: 12 });
    const plan = t.api.planBuildAll(p.id, sid);
    expect(plan.today).toEqual(u.slice(0, 2));
    expect(plan.later).toEqual(u.slice(2));
    const started = t.api.startBuildAll(p.id, sid);
    expect(started.jobs).toHaveLength(2);
    expect(started.deferred).toEqual(u.slice(2));
    for (const j of started.jobs) await done(t, j);
    let v = t.api.getTextbookView(p.id, sid);
    expect(v.chapters.slice(0, 3).map((c) => [c.status, c.deferred])).toEqual([['done', false], ['done', false], ['none', true]]);
    expect(v.deferred).toEqual(u.slice(2));
    expect(v.deferredAt).toBe('2026-12-01');
    expect(t.api.usage().used).toBe(10);
    // 同じ日のうちは、続きは始まらない(目次を開いても、起動し直しても)
    expect(t.api.resumeDeferredChapters()).toEqual([]);
    expect(t.api.listJobs().filter((j) => j.status === 'queued' || j.status === 'running')).toHaveLength(0);

    // 翌日: アプリを起動し直しても、回した章は toc.json に残っていて、続きから並ぶ(その日の上限のぶんだけ)
    process.env.ME_TODAY = '2026-12-02';
    const next = makeCore({}, t.dir);
    expect(next.api.usage().used).toBe(0);
    const resumed = next.api.resumeDeferredChapters();
    expect(resumed.map((j) => (j.params as { unitId: string }).unitId)).toEqual(u.slice(2, 4));
    v = next.api.getTextbookView(p.id, sid); // もう一度呼んでも、二重には並ばない
    expect(next.api.listJobs()).toHaveLength(2);
    expect(v.deferred).toEqual(u.slice(4));
    expect(v.deferredAt).toBe('2026-12-02');
    for (const j of resumed) await done(next, j);
    expect(next.api.getTextbookView(p.id, sid).counts).toMatchObject({ done: 4 });

    // 予約の取り消し
    next.api.cancelDeferred(p.id, sid);
    expect(next.api.getTextbookView(p.id, sid)).toMatchObject({ deferred: [], deferredAt: null });
    process.env.ME_TODAY = '2026-12-03';
    expect(next.api.resumeDeferredChapters()).toEqual([]);
  });

  it('作っている途中で1日の上限に達した章は、後日に回る', async () => {
    process.env.ME_TODAY = '2026-12-01';
    const { t, p, sid, u } = setup();
    t.api.updateSettings({ dailyLimit: 6 }); // 目安では 1 章ぶん。2 章目は途中で上限に当たる
    await done(t, t.api.startCreateChapter(p.id, sid, u[0]));
    const failed = await settled(t, t.api.startCreateChapter(p.id, sid, u[1]));
    expect(failed.error?.kind).toBe('daily_limit');
    const v = t.api.getTextbookView(p.id, sid);
    expect(v.deferred).toEqual([u[1]]);
    expect(v.chapters[1]).toMatchObject({ status: 'none', deferred: true });
    expect(t.api.planBuildAll(p.id, sid).today).toEqual([]); // 今日はもう作れない
    process.env.ME_TODAY = '2026-12-02';
    const jobs = t.api.resumeDeferredChapters();
    expect(jobs).toHaveLength(1);
    await done(t, jobs[0]);
    expect(t.api.getTextbookView(p.id, sid).chapters[1].status).toBe('done');
  });
});
