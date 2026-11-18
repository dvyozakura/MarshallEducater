import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../../src/core/claude/prompts';
import { explanationsHtml } from '../../src/core/print';
import { Files, readData } from '../../src/core/store';
import { ChatOutputSchema, ExplainOutputSchema, NoteOutputSchema } from '../../src/shared/schema';
import { done, settled, setupTest, submitAndGrade } from './helpers';

describe('解説・授業ノート・質問のプロンプトと型', () => {
  it('解説: 考え方 → 解き方 → 同じミスを防ぐ一言', () => {
    const p = buildPrompt({ kind: 'explain', vars: { subjectName: '数学', testTitle: '診断' }, inputFile: 'in.json', outputFile: 'out.json', schema: ExplainOutputSchema });
    for (const w of ['考え方', '解き方', '同じミスを防ぐ一言', '"thinking"', '"solution"', '"tip"', 'ME_PROMPT_KIND: explain']) expect(p, w).toContain(w);
    expect(ExplainOutputSchema.safeParse({ items: [{ problemId: 'p1', thinking: 'a' }] }).success).toBe(false);
  });
  it('授業ノート: 要点・例題・よくある誤り', () => {
    const p = buildPrompt({ kind: 'note', vars: { subjectName: '数学', unitName: '漸化式' }, inputFile: 'in.json', outputFile: 'out.json', schema: NoteOutputSchema });
    for (const w of ['# 漸化式', '## 要点', '## 例題', '## よくある誤り', '教科書の代わり', '"markdown"']) expect(p, w).toContain(w);
    expect(NoteOutputSchema.safeParse({ markdown: '' }).success).toBe(false);
  });
  it('質問: 問題・答案・採点・苦手マップを文脈に渡す', () => {
    const p = buildPrompt({ kind: 'chat', vars: { subjectName: '数学' }, inputFile: 'in.json', outputFile: 'out.json', schema: ChatOutputSchema });
    for (const w of ['`problem`', '`answer`', '`grading`', '`weakness`', '`history`', '`question`', '"answer"']) expect(p, w).toContain(w);
    expect(ChatOutputSchema.safeParse({ answer: '' }).success).toBe(false);
  });
});

describe('解説(偽 Claude)', () => {
  it('採点のあとに、間違えた問題ごとの解説が作られる(explanations.json と、人が読める explanations.md)', async () => {
    const { t, p, sid, ids, test } = await setupTest();
    const v = await submitAndGrade(t, ids, { p01: '2', p02: '99', p03: '位ごとに足すと 30 くらい' }); // p01 だけ正解
    expect(v.explanations!.items.map((i) => i.problemId)).toEqual(['p02', 'p03', 'p04']);
    const e = v.explanations!.items[0];
    expect(e.thinking).toContain(test.problems[1].unitName);
    expect(e.solution).toContain('$16 + 7 = 23$');
    expect(e.solution).toContain('99');
    expect(v.explanations!.items[2].tip).toContain('最初の一歩'); // 未解答に合わせた一言
    const call = t.fake.calls().filter((c) => c.kind === 'explain');
    expect(call).toHaveLength(1);
    expect(call[0].prompt).toContain(test.title);
    const tp = t.core.paths(p.id).subject(sid).test(test.id);
    const md = readFileSync(tp.explanationsMd, 'utf8');
    for (const w of [`# ${test.title} の解説`, '## 問2', '### 考え方', '### 解き方', '### 同じミスを防ぐ一言', 'あなたの答案: 99', '計算・処理ミス']) expect(md, w).toContain(w);
    expect(md).not.toContain('## 問1(');
    // 印刷用(PDF にする HTML)
    const html = explanationsHtml(v.test, '数学', v.grading!, v.key!, v.reading, v.explanations!);
    expect(html).toContain('同じミスを防ぐ一言');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('<h2>問1');
  });

  it('全問正解なら解説は作らない。採点前は作れない', async () => {
    const { t, ids } = await setupTest({ options: { designCount: 2 } });
    const early = await settled(t, t.api.startExplain(...ids));
    expect(early.error?.message).toContain('まだ採点されていません');
    const v = await submitAndGrade(t, ids, { p01: '2', p02: '23' });
    expect(v.totals).toEqual({ score: 20, max: 20 });
    expect(v.explanations).toBeNull();
    expect(t.fake.calls().filter((c) => c.kind === 'explain')).toHaveLength(0);
  });

  it('設問が抜けた出力はやり直させる。失敗しても採点は残り、あとから解説だけ作れる。上書きで増えた間違いは足りない分だけ作る', async () => {
    const { t, ids } = await setupTest({ kinds: { explain: ['missing', 'ok'] } });
    const v = await submitAndGrade(t, ids, { p01: '2', p02: '23', p03: '位ごとに足すと 26' }); // p04 だけ未解答
    expect(v.explanations!.items.map((i) => i.problemId)).toEqual(['p04']);
    // 1問だけだと、抜けると空になる → やり直しで直る
    const calls = t.fake.calls().filter((c) => c.kind === 'explain');
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain('解説がありません');

    // 上書きで p01 が 0 点になった → その設問の解説だけを足す
    t.api.overrideGrade(...ids, 'p01', 0, '確かめのため');
    await done(t, t.api.startExplain(...ids));
    expect(t.api.getResultView(...ids).explanations!.items.map((i) => i.problemId)).toEqual(['p01', 'p04']);
    const input = t.fake.calls().filter((c) => c.kind === 'explain').length;
    expect(input).toBe(3);

    // 解説づくりが失敗しても、採点は済んでいる
    const b = await setupTest({ kinds: { explain: 'fail' } });
    const vb = await submitAndGrade(b.t, b.ids, { p01: '1' });
    expect(vb.test.status).toBe('graded');
    expect(vb.explanations).toBeNull();
    expect(b.t.api.listJobs().find((j) => j.kind === 'explain')!.status).toBe('failed');
    b.t.fake.set({});
    await done(b.t, b.t.api.startExplain(...b.ids));
    expect(b.t.api.getResultView(...b.ids).explanations!.items).toHaveLength(4);
  });
});

describe('授業ノート(偽 Claude)', () => {
  it('単元ごとに作って notes/<単元>.md に残す。苦手の記録があれば渡し、作り直しでは前のノートを渡す', async () => {
    const { t, p, sid, ids, test } = await setupTest();
    const list0 = t.api.listNotes(p.id, sid);
    expect(list0.length).toBeGreaterThan(5);
    expect(list0.every((n) => !n.hasNote && n.mastery === null)).toBe(true);
    await submitAndGrade(t, ids, { p01: '2', p02: '99' });
    const unitId = test.problems[1].unitId; // 間違えた単元
    const list1 = t.api.listNotes(p.id, sid);
    expect(list1[0].mastery).not.toBeNull(); // 弱い単元が先
    expect(t.api.getNote(p.id, sid, unitId)).toBeNull();

    const job = await done(t, t.api.startCreateNote(p.id, sid, unitId));
    expect(job.title).toContain('授業ノート');
    const note = t.api.getNote(p.id, sid, unitId)!;
    expect(note.unitName).toBe(test.problems[1].unitName);
    for (const w of ['## 要点', '## 例題', '## よくある誤り', '$a^2 + b^2 = c^2$', '間違えた問題 1 件', 'テスト大学 理学部']) expect(note.markdown, w).toContain(w);
    expect(note.markdown).not.toContain('作り直し');
    expect(existsSync(t.core.paths(p.id).subject(sid).note(unitId))).toBe(true);
    expect(t.api.listNotes(p.id, sid).find((n) => n.unitId === unitId)).toMatchObject({ hasNote: true });
    const call = t.fake.calls().filter((c) => c.kind === 'note').at(-1)!;
    expect(call.prompt).toContain(`# ${note.unitName.split(' > ').pop()}`);

    await done(t, t.api.startCreateNote(p.id, sid, unitId));
    expect(t.api.getNote(p.id, sid, unitId)!.markdown).toContain('(作り直し)');
    expect((await settled(t, t.api.startCreateNote(p.id, sid, 'zzz'))).error?.message).toContain('単元ツリーにありません');
  });
});

describe('質問(偽 Claude)', () => {
  it('問題についての質問: 問題・答案・採点・解説・苦手マップが渡り、2往復目は会話の続きになる。やりとりは保存される', async () => {
    const { t, p, sid, ids } = await setupTest();
    await submitAndGrade(t, ids, { p01: '2', p02: '99' });
    expect(t.api.listChats(p.id, sid)).toEqual([]);
    expect(t.api.previewChatContext(p.id, sid, { testId: ids[2], problemId: 'p02' })).toMatchObject({ contextLabel: expect.stringContaining('問2'), problem: { id: 'p02' } });

    // 1往復目
    const a1 = t.api.askQuestion(p.id, sid, { context: { testId: ids[2], problemId: 'p02' }, question: 'なぜ 99 では駄目なのですか?' });
    expect(t.api.getChatView(p.id, sid, a1.chatId).chat.messages).toHaveLength(1); // 質問はすぐ保存される
    expect(t.api.listChats(p.id, sid)[0]).toMatchObject({ id: a1.chatId, waiting: true, title: 'なぜ 99 では駄目なのですか?' });
    await done(t, a1.job);
    const v1 = t.api.getChatView(p.id, sid, a1.chatId);
    expect(v1.contextLabel).toContain('問2');
    expect(v1.problem?.id).toBe('p02');
    expect(v1.chat.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const ans1 = v1.chat.messages[1].text;
    for (const w of ['「なぜ 99 では駄目なのですか?」への答え', '問題: 問2(正解は $23$)', 'あなたの答案: 99', '採点: 0 / 10(計算・処理ミス)', '解説を踏まえています', '苦手マップ: 弱い単元 4 件', 'これまでのやりとり: 0 件']) expect(ans1, w).toContain(w);
    expect(v1.chat.sessionId).toBeTruthy();
    const call1 = t.fake.calls().filter((c) => c.kind === 'chat').at(-1)!;
    expect(call1.argv).not.toContain('--resume');

    // 2往復目(同じ会話の続き)
    const a2 = t.api.askQuestion(p.id, sid, { chatId: a1.chatId, question: 'もう少しやさしく説明してください' });
    expect(a2.chatId).toBe(a1.chatId);
    await done(t, a2.job);
    const v2 = t.api.getChatView(p.id, sid, a1.chatId);
    expect(v2.chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(v2.chat.messages[3].text).toContain('これまでのやりとり: 2 件');
    expect(v2.chat.messages[3].text).toContain('「もう少しやさしく説明してください」');
    const call2 = t.fake.calls().filter((c) => c.kind === 'chat').at(-1)!;
    expect(call2.argv.slice(call2.argv.indexOf('--resume'))).toEqual(['--resume', v1.chat.sessionId]);

    // ファイルに残る(chats/<ID>.json)
    const saved = readData(t.core.paths(p.id).subject(sid).chat(a1.chatId), Files.chat);
    expect(saved.messages).toHaveLength(4);
    expect(saved.context).toEqual({ testId: ids[2], problemId: 'p02', unitId: null, chapterUnitId: null, textbook: false });
    expect(t.api.listChats(p.id, sid)).toMatchObject([{ id: a1.chatId, messages: 4, waiting: false }]);
  });

  it('採点前の問題は、正解を渡さない。授業ノート・科目全般についても質問できる', async () => {
    const { t, p, sid, ids, test } = await setupTest();
    const a = t.api.askQuestion(p.id, sid, { context: { testId: ids[2], problemId: 'p01' }, question: 'ヒントをください' });
    await done(t, a.job);
    const text = t.api.getChatView(p.id, sid, a.chatId).chat.messages[1].text;
    expect(text).toContain('正解はまだ見せません');
    expect(text).not.toContain('採点:');

    const unitId = test.problems[0].unitId;
    await done(t, t.api.startCreateNote(p.id, sid, unitId));
    const b = t.api.askQuestion(p.id, sid, { context: { unitId }, question: '例題の2行目が分かりません' });
    await done(t, b.job);
    const vb = t.api.getChatView(p.id, sid, b.chatId);
    expect(vb.contextLabel).toContain('授業ノート');
    expect(vb.chat.messages[1].text).toContain(`授業ノート「${test.problems[0].unitName}」を踏まえています`);

    const c = t.api.askQuestion(p.id, sid, { question: '勉強の順番はどうすればよいですか' });
    await done(t, c.job);
    expect(t.api.getChatView(p.id, sid, c.chatId).contextLabel).toBe('科目全般');
    expect(t.api.listChats(p.id, sid)).toHaveLength(3);
    expect(() => t.api.askQuestion(p.id, sid, { question: '  ' })).toThrow('質問を書いてください');
  });

  it('答えに失敗したら質問は残り、もう一度試せる。前の会話を続けられないときは新しい会話でやり直す', async () => {
    const { t, p, sid } = await setupTest({ kinds: { chat: ['usage_limit'] } });
    const a = t.api.askQuestion(p.id, sid, { question: '最初の質問' });
    const failed = await settled(t, a.job);
    expect(failed.error?.kind).toBe('usage_limit');
    expect(t.api.listChats(p.id, sid)[0]).toMatchObject({ waiting: true, messages: 1 });
    // 「もう一度試す」
    await done(t, t.api.retryJob(failed.id));
    expect(t.api.getChatView(p.id, sid, a.chatId).chat.messages).toHaveLength(2);
    // 答えの付いていない質問は、質問し直すと置き換わる
    t.fake.set({ kinds: { chat: ['fail', 'fail'] } });
    const b = t.api.askQuestion(p.id, sid, { chatId: a.chatId, question: '2つ目の質問' });
    expect((await settled(t, b.job)).status).toBe('failed'); // 続き(--resume)で失敗 → 新しい会話でも失敗
    const calls = t.fake.calls().filter((c) => c.kind === 'chat');
    expect(calls.at(-2)!.argv).toContain('--resume');
    expect(calls.at(-1)!.argv).not.toContain('--resume');
    t.fake.set({ kinds: { chat: ['fail'] } });
    const c = t.api.askQuestion(p.id, sid, { chatId: a.chatId, question: '2つ目の質問(書き直し)' });
    await done(t, c.job); // 続きで失敗 → 新しい会話で成功
    const msgs = t.api.getChatView(p.id, sid, a.chatId).chat.messages;
    expect(msgs.map((m) => m.text.slice(0, 12))).toEqual(['最初の質問', expect.any(String), '2つ目の質問(書き直し)', expect.any(String)]);
    expect(msgs[3].text).toContain('これまでのやりとり: 2 件');
  });
});
