import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../../src/core/claude/prompts';
import { getChapter, getChapterReview, textbookPaths } from '../../src/core/textbook';
import { ChatOutputSchema } from '../../src/shared/schema';
import { done, makeCore, sampleInput, settled, type TestCore } from './helpers';

async function setup(control: Record<string, unknown> = {}) {
  const t = makeCore(control);
  const p = t.api.createProject(sampleInput);
  const sid = p.subjects[0].id;
  const u = t.api.getTextbookView(p.id, sid).chapters.map((c) => c.unitId);
  await done(t, t.api.startCreateChapter(p.id, sid, u[0]));
  return { t, p, sid, u };
}
const kinds = (t: TestCore) => t.fake.calls().map((c) => c.kind);

describe('教材への質問', () => {
  it('プロンプト: 章・選んだ箇所・単元の苦手・目次を文脈として説明している', () => {
    const s = buildPrompt({ kind: 'chat', vars: { subjectName: '数学' }, inputFile: 'in.json', outputFile: 'out.json', schema: ChatOutputSchema });
    for (const w of ['`chapter`', '`unitWeakness`', '`textbook`', '`quote`', '確認問題']) expect(s, w).toContain(w);
  });

  it('章を選んで質問 → 2往復。章の本文・選んだ箇所・単元の苦手が渡り、会話は章ごとに保存されて続きができる', async () => {
    const { t, p, sid, u } = await setup();
    expect(t.api.findTextbookChat(p.id, sid, u[0])).toBeNull();
    const before = t.fake.calls().length;

    const q1 = t.api.askQuestion(p.id, sid, { context: { chapterUnitId: u[0] }, question: 'ここがわかりません', quote: '三平方の定理: $a^2 + b^2 = c^2$' });
    await done(t, q1.job);
    let v = t.api.findTextbookChat(p.id, sid, u[0])!;
    expect(v.chat.id).toBe(q1.chatId);
    expect(v.contextLabel).toContain('教材 第1章');
    expect(v.chat.context).toMatchObject({ chapterUnitId: u[0], textbook: false });
    expect(v.chat.messages[0]).toMatchObject({ role: 'user', quote: '三平方の定理: $a^2 + b^2 = c^2$' });
    const a1 = v.chat.messages[1].text;
    expect(a1).toContain('を踏まえています'); // 章の本文
    expect(a1).toContain('第 1 版、補足 0 件');
    expect(a1).toContain('選んだ箇所「三平方の定理');
    expect(a1).toContain('これまでのやりとり: 0 件');

    // 続き(同じ会話)
    await done(t, t.api.askQuestion(p.id, sid, { chatId: q1.chatId, question: 'もう少し詳しく' }).job);
    v = t.api.findTextbookChat(p.id, sid, u[0])!;
    expect(v.chat.messages).toHaveLength(4);
    expect(v.chat.messages[3].text).toContain('これまでのやりとり: 2 件');
    expect(v.chat.messages[3].text).not.toContain('選んだ箇所');
    expect(kinds(t).slice(before)).toEqual(['chat', 'chat']);

    // ほかの章・科目全体の会話とは分かれている
    expect(t.api.findTextbookChat(p.id, sid, u[1])).toBeNull();
    expect(t.api.findTextbookChat(p.id, sid, null)).toBeNull();
  });

  it('科目全体についての質問: 目次と苦手マップが渡る', async () => {
    const { t, p, sid } = await setup();
    const q = t.api.askQuestion(p.id, sid, { context: { textbook: true }, question: 'どの章から読めばいい?' });
    await done(t, q.job);
    const v = t.api.findTextbookChat(p.id, sid, null)!;
    expect(v.contextLabel).toBe('教材(科目全体)');
    expect(v.chat.messages[1].text).toContain(`教材の目次(${t.api.getTextbookView(p.id, sid).chapters.length} 章)`);
    expect(v.chat.messages[1].text).toContain('苦手マップ');
  });

  it('教材に反映: 補足を書く → 点検(指摘なし)→ 章に追記。前の版は versions/ に残り、点検の記録が増える', async () => {
    const { t, p, sid, u } = await setup();
    const q = t.api.askQuestion(p.id, sid, { context: { chapterUnitId: u[0] }, question: '公式の意味がわからない', quote: '三平方の定理' });
    await done(t, q.job);
    const before = t.fake.calls().length;
    const job = await done(t, t.api.startSupplement(p.id, sid, u[0], q.chatId));
    expect(job.title).toContain('に質問を反映');
    expect(job.result).toMatchObject({ unitId: u[0], chapterVersion: 2, issues: 0, revised: false });
    expect(kinds(t).slice(before)).toEqual(['chapter_supplement', 'chapter_review']);

    const ch = getChapter(t.core, p.id, sid, u[0])!;
    expect(ch.chapterVersion).toBe(2);
    expect(ch.supplements).toHaveLength(1);
    expect(ch.supplements[0]).toMatchObject({ chatId: q.chatId, title: '「公式の意味がわからない」についての補足' });
    expect(ch.supplements[0].markdown).toContain('やりとり 2 件');
    expect(ch.supplements[0].markdown).toContain('選んだ箇所: 「三平方の定理」');
    const tb = textbookPaths(t.core, p.id, sid);
    expect(existsSync(tb.versionJson(u[0], 1))).toBe(true);
    expect(readFileSync(tb.chapterMd(u[0]), 'utf8')).toContain('## 補足(質問から)');
    const recs = getChapterReview(t.core, p.id, sid, u[0])!.records;
    expect(recs.map((r) => r.target)).toEqual(['chapter', 'supplement']);
    expect(t.api.getTextbookView(p.id, sid).chapters[0]).toMatchObject({ chapterVersion: 2, status: 'done' });

    // 次の質問には、補足の入った章が渡る
    await done(t, t.api.askQuestion(p.id, sid, { chatId: q.chatId, question: 'ありがとう' }).job);
    expect(t.api.findTextbookChat(p.id, sid, u[0])!.chat.messages.at(-1)!.text).toContain('第 2 版、補足 1 件');
  });

  it('教材に反映: 点検で指摘があれば1回直してから追記する', async () => {
    const { t, p, sid, u } = await setup();
    const q = t.api.askQuestion(p.id, sid, { context: { chapterUnitId: u[0] }, question: 'なぜ?' });
    await done(t, q.job);
    t.fake.set({ kinds: { chapter_review: ['issues'] } });
    const job = await done(t, t.api.startSupplement(p.id, sid, u[0], q.chatId));
    expect(job.result).toMatchObject({ issues: 1, revised: true });
    const ch = getChapter(t.core, p.id, sid, u[0])!;
    expect(ch.supplements[0].markdown).toContain('点検の指摘 1 件を反映して直しました');
    const rec = getChapterReview(t.core, p.id, sid, u[0])!.records.at(-1)!;
    expect(rec).toMatchObject({ target: 'supplement', revised: true, verify: null });
    expect(t.api.getQuality().textbook).toMatchObject({ reviews: 2, withIssues: 1, revised: 1 });
  });

  it('教材に反映: 答えの無いやりとり・別の章のやりとりでは失敗する', async () => {
    const { t, p, sid, u } = await setup({ kinds: { chat: ['fail'] } });
    const q = t.api.askQuestion(p.id, sid, { context: { chapterUnitId: u[0] }, question: 'なぜ?' });
    await settled(t, q.job);
    const j1 = await settled(t, t.api.startSupplement(p.id, sid, u[0], q.chatId));
    expect(j1.status).toBe('failed');
    expect(j1.error?.message).toContain('まだ答えの付いた質問がありません');
    // まだ作っていない章には足せない
    const j2 = await settled(t, t.api.startSupplement(p.id, sid, u[1], q.chatId));
    expect(j2.error?.message).toContain('まだ作っていません');
    // 別の章についてのやりとりは、その章には足せない
    t.fake.set({});
    await done(t, t.api.startCreateChapter(p.id, sid, u[1]));
    const j3 = await settled(t, t.api.startSupplement(p.id, sid, u[1], q.chatId));
    expect(j3.error?.message).toContain('この章についてのものではありません');
    expect(getChapter(t.core, p.id, sid, u[0])!.chapterVersion).toBe(1);
  });
});
