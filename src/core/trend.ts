// 志望校の傾向: 確定した過去問から、科目ごとに出題形式・大問構成・頻出単元などを Claude がまとめる(trend.json と trend.md)。
import { existsSync } from 'node:fs';
import { FORMAT_VERSION, TrendOutputSchema, type Trend } from '../shared/schema';
import type { AppCore } from './app';
import { callClaude } from './claude/task';
import { listConfirmedSources } from './correction';
import { writeFileAtomic } from './fsutil';
import type { JobContext } from './jobs';
import { getProject, getSubject } from './projects';
import { Files, readData, writeData } from './store';
import { listTests } from './tests';
import { getUnits, projectBrief, unitNameMap } from './units';

/** 1問につき、傾向の分析に渡す本文の長さ(暫定)。 */
const BODY_HEAD_CHARS = 500;

export function getTrend(core: AppCore, projectId: string, subjectId: string): Trend | null {
  const f = core.paths(projectId).subject(subjectId).trendJson;
  return existsSync(f) ? readData(f, Files.trend) : null;
}

export interface TrendView {
  trend: Trend | null;
  /** 確定した過去問(傾向の材料)。 */
  pastExams: Array<{ id: string; title: string; used: boolean }>;
  /** 確定した過去問が、前回まとめたときから変わっている(増えた・減った)。 */
  stale: boolean;
  /** 傾向が分かったあと、まだ診断テストを作り直していない → 再診断を提案する。 */
  suggestRediagnosis: boolean;
}

export function getTrendView(core: AppCore, projectId: string, subjectId: string): TrendView {
  const trend = getTrend(core, projectId, subjectId);
  const confirmed = listConfirmedSources(core, projectId, subjectId, 'past_exam').map((s) => s.source);
  const used = new Set(trend?.basedOn ?? []);
  const stale = confirmed.length > 0 && (confirmed.length !== used.size || confirmed.some((s) => !used.has(s.id)));
  const diagnostics = listTests(core, projectId, subjectId).filter((t) => t.kind === 'diagnostic');
  const suggestRediagnosis = !!trend && diagnostics.length > 0 && !diagnostics.some((t) => t.createdAt > trend.updatedAt);
  return { trend, pastExams: confirmed.map((s) => ({ id: s.id, title: s.title, used: used.has(s.id) })), stale, suggestRediagnosis };
}

function trendMarkdown(subjectName: string, t: Trend, titles: string[]): string {
  return [
    `# ${subjectName} の出題傾向`,
    '',
    `更新: ${t.updatedAt.slice(0, 10)} / もとにした過去問: ${titles.join('、')}`,
    '',
    t.summaryMd.trim(),
    '',
    '## 出題形式',
    t.format,
    '',
    '## 大問構成',
    ...t.structure.map((s) => `- **${s.label}**: ${s.description}`),
    '',
    '## 頻出単元',
    ...t.frequentUnits.map((u) => `- ${u.unit}${u.note ? `: ${u.note}` : ''}`),
    '',
    '## 分量',
    t.volume,
    '',
    '## 時間配分',
    t.timeAllocation,
    '',
    '## 難易度',
    t.difficulty,
    '',
  ].join('\n');
}

/** 確定した過去問から、傾向を作る(すでにあれば更新する)。 */
export async function updateTrend(core: AppCore, projectId: string, subjectId: string, ctx: JobContext): Promise<Trend> {
  const project = getProject(core, projectId);
  const subject = getSubject(project, subjectId);
  const sp = core.paths(projectId).subject(subjectId);
  // 未確定の資料は listConfirmedSources が外す
  const sources = listConfirmedSources(core, projectId, subjectId, 'past_exam');
  if (sources.length === 0) throw new Error('確定した過去問がありません。過去問の PDF を取り込み、補正画面で確かめて「確定」してください。');
  const tree = getUnits(core, projectId, subjectId).tree;
  const names = unitNameMap(tree);
  const previous = getTrend(core, projectId, subjectId);
  ctx.progress(`${core.who('trend', projectId)} が過去問 ${sources.length} 件から傾向をまとめています`);
  const r = await callClaude({
    projectDir: core.projectDir(projectId),
    kind: 'trend',
    vars: { subjectName: subject.name, university: project.university, faculty: project.faculty },
    input: {
      subject: subject.name,
      project: projectBrief(project),
      sources: sources.map((s) => ({
        id: s.source.id,
        title: s.source.title,
        pageCount: s.source.pageCount,
        problems: s.problems.map((p) => ({
          number: p.number,
          major: p.major,
          minor: p.minor,
          points: p.points,
          answerFormat: p.answerFormat,
          unitName: names.get(p.unit) ?? '',
          bodyHead: p.body.slice(0, BODY_HEAD_CHARS),
          bodyChars: p.body.length,
          choices: p.choices.length,
          figures: p.figures.length,
        })),
      })),
      units: [...names.entries()].map(([id, name]) => ({ id, name })),
      previous: previous ? { format: previous.format, structure: previous.structure, frequentUnits: previous.frequentUnits, volume: previous.volume, timeAllocation: previous.timeAllocation, difficulty: previous.difficulty } : null,
    },
    schema: TrendOutputSchema,
    env: core.claudeEnv(),
    signal: ctx.signal,
    check: (d) => (d.summaryMd.trim() && d.format.trim() ? null : 'format と summaryMd は空にしないでください。'),
  });
  const trend = writeData(sp.trendJson, Files.trend, { ...r.data, version: FORMAT_VERSION, updatedAt: new Date().toISOString(), basedOn: sources.map((s) => s.source.id) });
  writeFileAtomic(
    sp.trendMd,
    trendMarkdown(
      subject.name,
      trend,
      sources.map((s) => s.source.title),
    ),
  );
  return trend;
}
