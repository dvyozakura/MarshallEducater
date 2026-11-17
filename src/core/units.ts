import { existsSync } from 'node:fs';
import {
  AdjustUnitsOutputSchema,
  EXAM_TYPE_LABEL,
  FORMAT_VERSION,
  TARGET_LEVEL_LABEL,
  type Project,
  type UnitNode,
  type Units,
} from '../shared/schema';
import { flattenUnits } from '../shared/subjects';
import type { AppCore } from './app';
import { callClaude } from './claude/task';
import type { JobContext } from './jobs';
import { getProject, getSubject } from './projects';
import { Files, readData, readDataOr, writeData } from './store';

export function getUnits(core: AppCore, projectId: string, subjectId: string): Units {
  return readData(core.paths(projectId).subject(subjectId).unitsJson, Files.units);
}

/** ツリーの誤り(空の名前、ID の重なり、深すぎ)を調べる。問題が無ければ null。 */
export function validateTree(tree: UnitNode[]): string | null {
  const seen = new Set<string>();
  let problem: string | null = null;
  const walk = (nodes: UnitNode[], depth: number) => {
    for (const n of nodes) {
      if (problem) return;
      if (!n.name.trim()) problem = '名前が空の単元があります';
      else if (!n.id.trim()) problem = 'ID が空の単元があります';
      else if (seen.has(n.id)) problem = `単元の ID「${n.id}」が重なっています`;
      else if (depth > 3) problem = '単元の階層は3段までにしてください';
      else if (!(n.weight >= 0 && n.weight <= 3)) problem = `単元「${n.name}」の重みは 0〜3 にしてください`;
      seen.add(n.id);
      walk(n.children, depth + 1);
    }
  };
  walk(tree, 1);
  if (!problem && tree.length === 0) problem = '単元が1つもありません';
  return problem;
}

function normalizeTree(tree: UnitNode[]): UnitNode[] {
  return tree.map((n) => ({
    id: n.id.trim(),
    name: n.name.trim(),
    weight: Math.round(Math.max(0, Math.min(3, n.weight))),
    children: normalizeTree(n.children ?? []),
  }));
}

/** ユーザーが編集したツリーを保存する。 */
export function saveUnits(core: AppCore, projectId: string, subjectId: string, tree: UnitNode[]): Units {
  const normalized = normalizeTree(tree);
  const problem = validateTree(normalized);
  if (problem) throw new Error(problem);
  const file = core.paths(projectId).subject(subjectId).unitsJson;
  const current = readDataOr(file, Files.units, () => ({ version: FORMAT_VERSION, tree: [], adjustedAt: null, note: '' }));
  return writeData(file, Files.units, { ...current, tree: normalized });
}

/** 単元 ID → 表示名(「親 > 子」)。消された単元の記録も読めるよう、無ければ ID をそのまま返す。 */
export function unitNameMap(tree: UnitNode[]): Map<string, string> {
  return new Map(flattenUnits(tree).map((u) => [u.id, u.fullName]));
}

export function projectBrief(project: Project): Record<string, unknown> {
  return {
    university: project.university,
    faculty: project.faculty,
    examDate: project.examDate,
    examType: EXAM_TYPE_LABEL[project.examType],
    targetLevel: TARGET_LEVEL_LABEL[project.targetLevel],
    dailyMinutes: project.dailyMinutes,
  };
}

/** Claude に、目標と難易度に合わせて単元ツリーを調整させる(増減・重み付け)。 */
export async function adjustUnits(core: AppCore, projectId: string, subjectId: string, ctx: JobContext): Promise<Units> {
  const project = getProject(core, projectId);
  const subject = getSubject(project, subjectId);
  const sp = core.paths(projectId).subject(subjectId);
  const current = getUnits(core, projectId, subjectId);
  const trend = existsSync(sp.trendJson) ? readData(sp.trendJson, Files.trend) : null;
  ctx.progress('Claude が単元を見直しています');
  const r = await callClaude({
    projectDir: core.projectDir(projectId),
    kind: 'adjust_units',
    vars: { subjectName: subject.name },
    input: {
      subject: subject.name,
      project: projectBrief(project),
      tree: current.tree,
      trend: trend ? { format: trend.format, frequentUnits: trend.frequentUnits, difficulty: trend.difficulty } : null,
    },
    schema: AdjustUnitsOutputSchema,
    env: core.claudeEnv(),
    signal: ctx.signal,
    check: (d) => validateTree(normalizeTree(d.tree)),
  });
  return writeData(sp.unitsJson, Files.units, {
    version: FORMAT_VERSION,
    tree: normalizeTree(r.data.tree),
    adjustedAt: new Date().toISOString(),
    note: r.data.note,
  });
}
