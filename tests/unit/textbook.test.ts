import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Files, readData, writeData } from '../../src/core/store';
import { chapterFileId, chapterSpec, staleReasonFor, syncToc, textbookPaths, thicknessFor } from '../../src/core/textbook';
import { ChapterSchema, FORMAT_VERSION, TocSchema, type Chapter, type Thickness, type TocChapter } from '../../src/shared/schema';
import { makeCore, sampleInput, setupTest, submitAndGrade, type TestCore } from './helpers';

/** 手で章を1つ置く(章づくりの仕組みを通さない最小のもの)。 */
export function putChapter(t: TestCore, projectId: string, subjectId: string, unitId: string, over: Partial<Chapter> = {}): Chapter {
  const tb = textbookPaths(t.core, projectId, subjectId);
  const at = new Date().toISOString();
  const ch = writeData(tb.chapterJson(chapterFileId(unitId)), Files.chapter, {
    version: FORMAT_VERSION,
    unitId,
    title: '手で置いた章',
    chapterVersion: 1,
    createdAt: at,
    updatedAt: at,
    thickness: 'standard' as Thickness,
    unlearned: false,
    masteryAtBuild: null,
    intro: '導入',
    points: '要点 $x^2$',
    pitfalls: '誤り',
    figures: [],
    examples: [],
    quiz: [],
    quizTestId: null,
    supplements: [],
    ...over,
  });
  writeFileSync(tb.chapterMd(chapterFileId(unitId)), `# ${ch.title}\n`, 'utf8');
  return ch;
}

function setup() {
  const t = makeCore();
  const p = t.api.createProject(sampleInput);
  return { t, p, sid: p.subjects[0].id };
}

describe('教材の型', () => {
  it('目次・章・点検結果の型。足りない項目は既定値で補い、おかしな値は断る', () => {
    const toc = TocSchema.parse({ version: 1, chapters: [{ unitId: 'u01-01', title: 'A > a' }] });
    expect(toc.chapters[0]).toMatchObject({ status: 'none', read: false, unlearned: false, chapterVersion: 0, orphan: false, quizTestId: null });
    expect(toc.deferred).toEqual([]);
    expect(TocSchema.safeParse({ version: 1, chapters: [{ unitId: 'u1', title: 'x', status: 'finished' }] }).success).toBe(false);
    expect(ChapterSchema.safeParse({ version: 1, unitId: 'u1', title: 'x', chapterVersion: 0 }).success).toBe(false);
  });

  it('厚さの決め方: 未習と苦手は詳しく・例題を多く、得意は要点中心で薄く、診断前は標準', () => {
    expect(thicknessFor(null, false)).toBe('standard');
    expect(thicknessFor(30, false)).toBe('thick');
    expect(thicknessFor(60, false)).toBe('standard');
    expect(thicknessFor(80, false)).toBe('thin');
    expect(thicknessFor(90, true)).toBe('thick');
    const thick = chapterSpec(30, false, 'kokkoritsu');
    const std = chapterSpec(null, false, 'kokkoritsu');
    const thin = chapterSpec(90, false, 'kokkoritsu');
    expect([thick.examples.length, std.examples.length, thin.examples.length]).toEqual([4, 2, 1]);
    expect([thick.quiz.length, std.quiz.length, thin.quiz.length]).toEqual([4, 3, 2]);
    expect(chapterSpec(null, true, 'kokkoritsu').style).toContain('未習');
    // 共通テスト型は、例題も確認問題もすべて選択式
    const k = chapterSpec(30, false, 'kyotsu');
    expect([...k.examples, ...k.quiz].every((x) => x.format === 'choice')).toBe(true);
  });
});

describe('教材の目次', () => {
  it('単元ツリーの順に章が並ぶ(出題の対象の葉だけ)。最初はすべて未作成', () => {
    const { t, p, sid } = setup();
    const v = t.api.getTextbookView(p.id, sid);
    const leaves = t.api.getUnits(p.id, sid).tree.flatMap((n) => n.children.map((c) => ({ id: c.id, title: `${n.name} > ${c.name}`, group: n.name, name: c.name })));
    expect(v.chapters.map((c) => c.unitId)).toEqual(leaves.map((l) => l.id));
    expect(v.chapters.map((c) => c.no)).toEqual(leaves.map((_l, i) => i + 1));
    expect(v.chapters[0]).toMatchObject({ title: leaves[0].title, group: leaves[0].group, name: leaves[0].name, status: 'none', read: false, unlearned: false, mastery: null, plannedThickness: 'standard', hasNote: false, job: null, quiz: null });
    expect(v.counts).toMatchObject({ none: leaves.length, done: 0, total: leaves.length, read: 0 });
    // toc.json として保存される
    const saved = readData(textbookPaths(t.core, p.id, sid).tocJson, Files.toc);
    expect(saved.chapters).toHaveLength(leaves.length);
    expect(saved.version).toBe(FORMAT_VERSION);
  });

  it('単元ツリーが後から変わったら追従する: 追加・名前の変更・並べ替え・削除(作った章は「外れた章」として残す)', () => {
    const { t, p, sid } = setup();
    const before = t.api.getTextbookView(p.id, sid);
    const tree = t.api.getUnits(p.id, sid).tree;
    const [a, b, c] = [tree[0].children[0], tree[0].children[1], tree[0].children[2]];
    putChapter(t, p.id, sid, a.id);
    putChapter(t, p.id, sid, b.id);
    t.api.setChapterUnlearned(p.id, sid, c.id, true);
    t.api.setChapterRead(p.id, sid, b.id, true);

    // a を消す(章あり)、b の名前を変える、c を先頭へ、新しい単元を足す、最後の大単元を「扱わない」にする
    const lastTop = tree[tree.length - 1];
    const next = structuredClone(tree);
    next[0].children = [{ ...c }, { ...b, name: '名前を変えた単元' }, ...next[0].children.slice(3), { id: 'u01-77', name: '足した単元', weight: 1, children: [] }];
    next[next.length - 1].weight = 0;
    t.api.saveUnits(p.id, sid, next);

    const v = t.api.getTextbookView(p.id, sid);
    const ids = v.chapters.map((x) => x.unitId);
    expect(ids.slice(0, 2)).toEqual([c.id, b.id]);
    expect(ids).toContain('u01-77');
    for (const gone of lastTop.children) expect(ids).not.toContain(gone.id); // 章の無い単元は、目次から消える
    expect(v.counts.total).toBe(before.counts.total - 1 + 1 - lastTop.children.length);
    // 印と状態は引き継ぐ
    expect(v.chapters.find((x) => x.unitId === c.id)).toMatchObject({ unlearned: true, no: 1, plannedThickness: 'thick' });
    expect(v.chapters.find((x) => x.unitId === b.id)).toMatchObject({ name: '名前を変えた単元', status: 'done', read: true, no: 2 });
    expect(v.chapters.find((x) => x.unitId === 'u01-77')).toMatchObject({ status: 'none', name: '足した単元' });
    // 消した単元の章は、消さずに最後に残す
    const orphan = v.chapters.at(-1)!;
    expect(orphan).toMatchObject({ unitId: a.id, orphan: true, no: 0, status: 'done' });
    expect(existsSync(textbookPaths(t.core, p.id, sid).chapterJson(a.id))).toBe(true);

    // 単元を戻せば、章も目次の中に戻る
    t.api.saveUnits(p.id, sid, tree);
    const back = t.api.getTextbookView(p.id, sid);
    expect(back.chapters.map((x) => x.unitId)).toEqual(before.chapters.map((x) => x.unitId));
    expect(back.chapters[0]).toMatchObject({ unitId: a.id, orphan: false, status: 'done', no: 1 });
  });

  it('状態の保存: 既読・未習の印は、読み直しても(起動し直しても)残る。未作成の章は既読にできない', () => {
    const { t, p, sid } = setup();
    const [u1, u2] = t.api.getTextbookView(p.id, sid).chapters.map((c) => c.unitId);
    expect(() => t.api.setChapterRead(p.id, sid, u1, true)).toThrow('まだ作っていない章');
    expect(() => t.api.setChapterUnlearned(p.id, sid, 'zzz', true)).toThrow('目次にありません');
    putChapter(t, p.id, sid, u1, { thickness: 'standard' });
    t.api.setChapterRead(p.id, sid, u1, true);
    t.api.setChapterUnlearned(p.id, sid, u2, true);

    // 同じデータの場所で、アプリを起動し直したことにする
    const again = makeCore({}, t.dir);
    const v = again.api.getTextbookView(p.id, sid);
    expect(v.chapters[0]).toMatchObject({ status: 'done', read: true, chapterVersion: 1, thickness: 'standard' });
    expect(v.chapters[0].readAt).toBeTruthy();
    expect(v.chapters[1]).toMatchObject({ status: 'none', unlearned: true });
    expect(v.counts).toMatchObject({ done: 1, read: 1 });
    again.api.setChapterRead(p.id, sid, u1, false);
    expect(again.api.getTextbookView(p.id, sid).chapters[0]).toMatchObject({ read: false, readAt: null });

    // 目次のファイルが消えても、章のファイルから「完成」に戻る。章のファイルが消えたら「未作成」に戻る
    const tb = textbookPaths(t.core, p.id, sid);
    rmSync(tb.tocJson);
    expect(again.api.getTextbookView(p.id, sid).chapters[0]).toMatchObject({ status: 'done', chapterVersion: 1 });
    rmSync(tb.chapterJson(u1));
    expect(again.api.getTextbookView(p.id, sid).chapters[0]).toMatchObject({ status: 'none', chapterVersion: 0 });
    // 壊れた目次は、黙って上書きしない
    writeFileSync(tb.tocJson, '{ "version": 1, "chapters": [', 'utf8');
    expect(() => again.api.getTextbookView(p.id, sid)).toThrow('壊れていて読めません');
    expect(readFileSync(tb.tocJson, 'utf8')).toContain('"chapters": [');
  });

  it('作り直しの提案: 未習の印が変わった・習熟度が大きく変わって厚さの区分も変わった、のときだけ', async () => {
    const base: TocChapter = TocSchema.parse({ version: 1, chapters: [{ unitId: 'u', title: 't', chapterVersion: 1, thickness: 'standard', masteryAtBuild: 60, unlearnedAtBuild: false }] }).chapters[0];
    expect(staleReasonFor(base, 60)).toBe('');
    expect(staleReasonFor(base, 50)).toBe(''); // 区分が同じ
    expect(staleReasonFor(base, 44)).toContain('60 → 44'); // 16 動いて「詳しい」へ
    expect(staleReasonFor({ ...base, masteryAtBuild: 46 }, 44)).toBe(''); // 区分は変わったが、動きが小さい
    expect(staleReasonFor(base, 90)).toContain('要点中心');
    expect(staleReasonFor({ ...base, unlearned: true }, 60)).toContain('未習');
    expect(staleReasonFor({ ...base, masteryAtBuild: null }, 20)).toContain('診断の結果');
    expect(staleReasonFor({ ...base, masteryAtBuild: null }, null)).toBe('');
    expect(staleReasonFor({ ...base, chapterVersion: 0 }, 10)).toBe('');

    // 診断前に作った章(標準の厚さ)→ 採点で苦手と分かる →「作り直しを提案」。勝手には作り直さない
    const { t, p, sid, ids, test } = await setupTest();
    const weak = test.problems[1].unitId;
    const other = test.problems[0].unitId;
    putChapter(t, p.id, sid, weak);
    putChapter(t, p.id, sid, other);
    expect(t.api.getTextbookView(p.id, sid).chapters.find((c) => c.unitId === weak)).toMatchObject({ status: 'done', staleReason: '' });
    await submitAndGrade(t, ids, { p01: '2', p02: '99' }); // p01(易)は正解、p02 は誤答
    const v = t.api.getTextbookView(p.id, sid);
    const w = v.chapters.find((c) => c.unitId === weak)!;
    expect(w.status).toBe('stale');
    expect(w.staleReason).toContain('詳しい');
    expect(w.mastery).toBeLessThan(45);
    expect(v.chapters.find((c) => c.unitId === other)).toMatchObject({ status: 'done' });
    expect(v.counts.stale).toBe(1);
    expect(syncToc(t.core, p.id, sid).chapters.find((c) => c.unitId === weak)!.status).toBe('stale'); // toc.json にも入る
    expect(t.fake.calls().some((c) => c.kind.startsWith('chapter'))).toBe(false);
  });

  it('既存の授業ノートは消さず、該当する章の補足として目次から開ける。章の無い単元のノートも一覧に残す', async () => {
    const { t, p, sid } = setup();
    const u1 = t.api.getTextbookView(p.id, sid).chapters[0].unitId;
    const job = t.api.startCreateNote(p.id, sid, u1);
    await t.core.jobs.wait(job.id);
    expect(t.api.getTextbookView(p.id, sid).chapters[0].hasNote).toBe(true);
    expect(t.api.getTextbookView(p.id, sid).chapters[1].hasNote).toBe(false);
    // 単元を消しても、ノートのファイルは残り、一覧から開ける
    const tree = structuredClone(t.api.getUnits(p.id, sid).tree);
    tree[0].children.shift();
    t.api.saveUnits(p.id, sid, tree);
    const v = t.api.getTextbookView(p.id, sid);
    expect(v.chapters.some((c) => c.unitId === u1)).toBe(false);
    expect(v.otherNotes.map((n) => n.unitId)).toEqual([u1]);
    expect(t.api.getNote(p.id, sid, u1)!.markdown).toContain('## 要点');
  });
});
