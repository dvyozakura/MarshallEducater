import { describe, expect, it } from 'vitest';
import { validateTree } from '../../src/core/units';
import { findUnit, flattenUnits, initialUnitTree, leafUnits, parseOutline, SUBJECT_PRESETS } from '../../src/shared/subjects';
import { done, makeCore, sampleInput, settled } from './helpers';

describe('初期の単元ツリー', () => {
  it('主要科目すべてで、誤りの無いツリーになる', () => {
    expect(SUBJECT_PRESETS.length).toBeGreaterThanOrEqual(12);
    for (const p of SUBJECT_PRESETS) {
      const tree = initialUnitTree(p.name);
      expect(validateTree(tree), p.name).toBeNull();
      expect(tree.length, p.name).toBeGreaterThanOrEqual(4);
      for (const top of tree) expect(top.children.length, `${p.name} ${top.name}`).toBeGreaterThanOrEqual(2);
      const names = flattenUnits(tree).map((u) => u.fullName);
      expect(new Set(names).size, p.name).toBe(names.length);
    }
  });

  it('「親: 子, 子」を読める。かっこの中の読点では切らない', () => {
    const tree = parseOutline('数列: 等差数列・等比数列, 漸化式\n文法: 準動詞(不定詞, 動名詞), 比較');
    expect(tree.map((t) => t.id)).toEqual(['u01', 'u02']);
    expect(tree[0].children.map((c) => `${c.id}:${c.name}`)).toEqual(['u01-01:等差数列・等比数列', 'u01-02:漸化式']);
    expect(tree[1].children.map((c) => c.name)).toEqual(['準動詞(不定詞, 動名詞)', '比較']);
  });

  it('一覧に無い科目でも、最小限のツリーができる', () => {
    expect(validateTree(initialUnitTree('小論文'))).toBeNull();
  });

  it('重み 0 の単元(とその下)は出題の対象から外れる', () => {
    const tree = parseOutline('A: a1, a2\nB: b1, b2');
    tree[0].weight = 0;
    tree[1].children[0].weight = 0;
    expect(leafUnits(tree).map((u) => u.name)).toEqual(['b2']);
    expect(findUnit(tree, 'u02-02')?.name).toBe('b2');
  });
});

describe('単元ツリーの編集と保存', () => {
  it('ユーザーの編集を保存できる。誤り(空の名前・ID の重なり)は断る', () => {
    const t = makeCore();
    const p = t.api.createProject(sampleInput);
    const sid = p.subjects[0].id;
    const tree = t.api.getUnits(p.id, sid).tree;
    tree[0].name = '式と証明(改)';
    tree[0].weight = 2;
    tree.push({ id: 'x1', name: '追加した単元', weight: 1, children: [] });
    t.api.saveUnits(p.id, sid, tree);
    const saved = t.api.getUnits(p.id, sid);
    expect(saved.tree[0]).toMatchObject({ name: '式と証明(改)', weight: 2 });
    expect(saved.tree.at(-1)?.name).toBe('追加した単元');

    expect(() => t.api.saveUnits(p.id, sid, [{ id: 'a', name: ' ', weight: 1, children: [] }])).toThrow('名前が空');
    expect(() =>
      t.api.saveUnits(p.id, sid, [
        { id: 'a', name: 'x', weight: 1, children: [] },
        { id: 'a', name: 'y', weight: 1, children: [] },
      ]),
    ).toThrow('重なって');
    expect(() => t.api.saveUnits(p.id, sid, [])).toThrow('1つもありません');
    // 断られたあとも、前の内容のまま
    expect(t.api.getUnits(p.id, sid).tree[0].name).toBe('式と証明(改)');
  });
});

describe('Claude による単元の調整(偽 Claude)', () => {
  it('増減・重み付けが反映され、調整の方針が残る。プロンプトに目標が渡る', async () => {
    const t = makeCore();
    const p = t.api.createProject(sampleInput);
    const sid = p.subjects[0].id;
    const before = t.api.getUnits(p.id, sid);
    expect(before.adjustedAt).toBeNull();
    const job = await done(t, t.api.startAdjustUnits(p.id, sid));
    expect(job.title).toBe('数学II・B・C: 単元の調整');
    const after = t.api.getUnits(p.id, sid);
    expect(after.adjustedAt).not.toBeNull();
    expect(after.note).toContain('国公立二次');
    expect(after.tree[0].weight).toBe(3);
    expect(after.tree[0].children.at(-1)?.name).toBe('融合問題(目標校向け)');
    expect(after.tree.at(-1)?.children.at(-1)?.weight).toBe(0);
    // 既にある単元の ID と名前は変わらない
    expect(after.tree.map((n) => n.id)).toEqual(before.tree.map((n) => n.id));
    const call = t.fake.calls()[0];
    expect(call.kind).toBe('adjust_units');
    expect(call.prompt).toContain('科目「数学II・B・C」');
    expect(call.prompt).toContain('"weight"');
  });

  it('中身がおかしい出力(ID の重なり)はやり直させ、直らなければ失敗。元のツリーは変わらない', async () => {
    const t = makeCore({ kinds: { adjust_units: ['dup_id', 'dup_id', 'dup_id'] } });
    const p = t.api.createProject(sampleInput);
    const sid = p.subjects[0].id;
    const job = await settled(t, t.api.startAdjustUnits(p.id, sid));
    expect(job.status).toBe('failed');
    expect(job.error?.kind).toBe('invalid_output');
    expect(t.fake.calls()).toHaveLength(3);
    expect(t.fake.calls()[1].prompt).toContain('重なっています');
    expect(t.api.getUnits(p.id, sid).adjustedAt).toBeNull();
    // もう一度試す → 今度は成功
    const retry = await done(t, t.api.retryJob(job.id));
    expect(retry.status).toBe('done');
    expect(t.api.getUnits(p.id, sid).adjustedAt).not.toBeNull();
  });
});
