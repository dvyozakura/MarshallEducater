// テストの設計(何を何問・何分で出すかを Claude が決める)と、実力診断テストの作成。
import { existsSync } from 'node:fs';
import { DesignTestOutputSchema, TEST_KIND_LABEL, type DesignTestOutput, type ProblemOrigin, type Test, type Weakness } from '../shared/schema';
import { leafUnits } from '../shared/subjects';
import type { AppCore } from './app';
import { loadPromptSection } from './claude/prompts';
import { callClaude } from './claude/task';
import type { JobContext } from './jobs';
import { getProject, getSubject } from './projects';
import { Files, readData } from './store';
import { createTest, listTests } from './tests';
import { getUnits, projectBrief } from './units';

/** 設計で受け付ける問題数の上限(暫定)。多すぎる設計は、先頭からこの数までを使う。 */
export const MAX_DESIGN_ITEMS = 30;

/** 苦手マップから、弱い単元(習熟度が低い順)を取り出す。 */
export function weakUnits(weakness: Weakness | null, limit = 8): Array<{ unitId: string; unitName: string; mastery: number }> {
  if (!weakness) return [];
  return Object.entries(weakness.units)
    .filter(([, u]) => u.events.length > 0)
    .map(([unitId, u]) => ({ unitId, unitName: u.unitName, mastery: Math.round(u.mastery) }))
    .sort((a, b) => a.mastery - b.mastery)
    .slice(0, limit);
}

/** Claude に、テストの分量・制限時間・出題内容を決めさせる。 */
export async function designTest(core: AppCore, projectId: string, subjectId: string, kind: 'diagnostic' | 'mock', ctx: JobContext): Promise<DesignTestOutput> {
  const project = getProject(core, projectId);
  const subject = getSubject(project, subjectId);
  const sp = core.paths(projectId).subject(subjectId);
  const units = leafUnits(getUnits(core, projectId, subjectId).tree).map((u) => ({ id: u.id, name: u.fullName, weight: u.weight }));
  if (units.length === 0) throw new Error('出題できる単元がありません。科目の「単元」で、重みが 0 でない単元を残してください。');
  const trend = existsSync(sp.trendJson) ? readData(sp.trendJson, Files.trend) : null;
  const weakness = existsSync(sp.weaknessJson) ? readData(sp.weaknessJson, Files.weakness) : null;
  const ids = new Set(units.map((u) => u.id));
  ctx.progress(`${core.who('design_test', projectId)} が${TEST_KIND_LABEL[kind]}の内容を決めています`);
  const r = await callClaude({
    projectDir: core.projectDir(projectId),
    kind: 'design_test',
    vars: { subjectName: subject.name, purpose: TEST_KIND_LABEL[kind], rules: loadPromptSection('design_test_rules', kind) },
    input: {
      subject: subject.name,
      kind,
      project: projectBrief(project),
      units,
      trend: trend ? { format: trend.format, structure: trend.structure, frequentUnits: trend.frequentUnits, volume: trend.volume, timeAllocation: trend.timeAllocation, difficulty: trend.difficulty } : null,
      weak: weakUnits(weakness),
    },
    schema: DesignTestOutputSchema,
    env: core.claudeEnv(),
    signal: ctx.signal,
    check: (d) => {
      const bad = d.items.find((it) => !ids.has(it.unitId));
      return bad ? `unitId「${bad.unitId}」は、入力の units にありません(units の id だけを使う)。` : null;
    },
  });
  return { ...r.data, items: r.data.items.slice(0, MAX_DESIGN_ITEMS) };
}

/** 設計 → 問題の作成と検算 → テストとして保存、までを通しで行う。 */
export async function createDesignedTest(core: AppCore, projectId: string, subjectId: string, kind: 'diagnostic' | 'mock', ctx: JobContext, date: string | null = null): Promise<Test> {
  const subject = getSubject(getProject(core, projectId), subjectId);
  const design = await designTest(core, projectId, subjectId, kind, ctx);
  const origin: ProblemOrigin = kind;
  const count = listTests(core, projectId, subjectId).filter((t) => t.kind === kind).length;
  return createTest(
    core,
    projectId,
    subjectId,
    {
      kind,
      title: `${subject.name} ${TEST_KIND_LABEL[kind]}${count > 0 ? `(${count + 1}回目)` : ''}`,
      timeLimitMin: design.timeLimitMin,
      instructions: design.instructions,
      purpose: TEST_KIND_LABEL[kind],
      requests: design.items.map((it) => ({ unitId: it.unitId, difficulty: it.difficulty, format: it.format, origin })),
      date,
    },
    ctx,
  );
}
