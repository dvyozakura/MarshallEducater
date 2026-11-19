import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildPrompt, PROMPT_KINDS, TATEGAKI_MODE, tategakiSection } from '../../src/core/claude/prompts';
import { notationProblems } from '../../src/core/claude/task';
import { done, importFake, makeCore, sampleInput } from './helpers';

const S = z.object({ ok: z.boolean() });

describe('国語(縦書き)のプロンプト', () => {
  it('作る・読み取る・読むだけ、で足す説明が変わる。国語でなければ足さない', () => {
    const write = buildPrompt({ kind: 'generate_problems', vars: varsFor('generate_problems'), inputFile: null, outputFile: 'o.json', schema: S, tategaki: true });
    expect(write).toContain('ME_TATEGAKI: write');
    expect(write).toContain('{{傍線:ア|本文}}');
    expect(write).toContain('書き下ろした文章');
    const read = buildPrompt({ kind: 'read_pages', vars: varsFor('read_pages'), inputFile: null, outputFile: 'o.json', schema: S, tategaki: true });
    expect(read).toContain('ME_TATEGAKI: read');
    expect(read).toContain('右から左');
    const grade = buildPrompt({ kind: 'grade', vars: varsFor('grade'), inputFile: null, outputFile: 'o.json', schema: S, tategaki: true });
    expect(grade).toContain('ME_TATEGAKI: understand');
    expect(grade).toContain('横書きで表示');
    const plain = buildPrompt({ kind: 'generate_problems', vars: varsFor('generate_problems'), inputFile: null, outputFile: 'o.json', schema: S });
    expect(plain).not.toContain('ME_TATEGAKI');
    // 計画には足さない
    expect(tategakiSection('plan')).toBe('');
  });
  it('説明を足す種類はすべて、プロンプトの種類として存在する', () => {
    for (const k of Object.keys(TATEGAKI_MODE)) expect(PROMPT_KINDS).toContain(k);
    for (const k of Object.keys(TATEGAKI_MODE)) expect(tategakiSection(k as never).length).toBeGreaterThan(50);
  });
  it('出力の記法の誤りを見つける(SVG は対象外)', () => {
    expect(notationProblems({ problems: [{ body: '{{傍線:ア|正しい}}', figureSvg: '<svg>{{</svg>' }] })).toBeNull();
    const msg = notationProblems({ problems: [{ body: '{{傍線:ア|閉じていない' }] });
    expect(msg).toContain('problems.0.body');
    expect(msg).toContain('閉じ忘れ');
  });
});

/** プロンプトの変数を、テンプレートに出てくる名前ぶん空で埋める。 */
function varsFor(kind: string): Record<string, string> {
  const t = readFileSync(`src/prompts/${kind}.md`, 'utf8');
  return Object.fromEntries([...t.matchAll(/\{\{(\w+)\}\}/g)].map((m) => [m[1], '']));
}

describe('国語の科目で作らせる・読み取らせる(偽 Claude)', () => {
  it('診断テスト: 国語ではプロンプトに記法の説明が入り、壊れた記法はやり直させる。数学には入らない', async () => {
    const t = makeCore({ kinds: { generate_problems: ['bad_notation', 'ok'] } });
    const p = t.api.createProject({ ...sampleInput, subjectNames: ['現代文', '数学II・B・C'] });
    const [kokugo, math] = p.subjects;
    expect(kokugo.writingMode).toBe('vertical');
    expect(math.writingMode).toBe('horizontal');
    await done(t, t.api.startCreateDiagnostic(p.id, kokugo.id));
    const calls = t.fake.calls();
    const gen = calls.filter((c) => c.kind === 'generate_problems');
    expect(gen.length).toBe(2);
    expect(gen[0].prompt).toContain('ME_TATEGAKI: write');
    // 2回目は、記法の誤りを伝えてやり直させている
    expect(gen[1].prompt).toContain('縦書きの記法の書き方に誤りがあります');
    for (const k of ['design_test', 'solve_problems', 'judge_answers']) {
      const c = calls.find((x) => x.kind === k);
      if (c) expect(c.prompt).toContain('ME_TATEGAKI');
    }
    const [test] = t.api.listTests(p.id, kokugo.id);
    const full = t.api.getTest(p.id, kokugo.id, test.id);
    expect(full.problems[0].body).toContain('{{傍線:ア|時計}}');
    expect(full.problems[0].body).not.toContain('{{傍線:ア|時計は');

    const before = t.fake.calls().length;
    await done(t, t.api.startCreateDiagnostic(p.id, math.id));
    const mathCalls = t.fake.calls().slice(before);
    expect(mathCalls.length).toBeGreaterThan(0);
    for (const c of mathCalls) expect(c.prompt).not.toContain('ME_TATEGAKI');
  });

  it('縦書きの PDF の読み取り: 記法で写した結果を返す。壊れていればやり直させる', async () => {
    const t = makeCore({ kinds: { read_pages: ['bad_notation', 'ok'] } });
    const p = t.api.createProject({ ...sampleInput, subjectNames: ['漢文'] });
    const sid = p.subjects[0].id;
    const src = importFake(t, p.id, sid, 1);
    await done(t, t.api.startReadSource(p.id, sid, src));
    const reads = t.fake.calls().filter((c) => c.kind === 'read_pages');
    expect(reads.length).toBe(2);
    expect(reads[0].prompt).toContain('ME_TATEGAKI: read');
    const ex = t.api.getExtracted(p.id, sid, src)!;
    expect(ex.problems.some((q) => q.body.includes(':::漢文 訓読文'))).toBe(true);
    expect(ex.problems.some((q) => q.body.includes('{{傍点|まだ}}'))).toBe(true);
  });
});
