import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isValidDateString } from '../shared/dates';
import {
  EXAM_TYPE_LABEL,
  FORMAT_VERSION,
  ProjectInputSchema,
  TARGET_LEVEL_LABEL,
  type Project,
  type ProjectInput,
  type SubjectRef,
} from '../shared/schema';
import { initialUnitTree } from '../shared/subjects';
import type { AppCore } from './app';
import { loadPromptFile, renderTemplate } from './claude/prompts';
import { ensureDir, safeFileName, writeFileAtomic } from './fsutil';
import { ProjectPaths } from './paths';
import { Files, readData, writeData } from './store';

export interface ProjectListing {
  projects: Project[];
  /** 読めなかったフォルダ(壊れた project.json など)。 */
  broken: Array<{ folder: string; error: string }>;
}

export function listProjects(core: AppCore): ProjectListing {
  const dir = core.dataDir();
  const out: ProjectListing = { projects: [], broken: [] };
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    const file = join(p, 'project.json');
    if (!existsSync(file)) continue;
    try {
      out.projects.push(readData(file, Files.project));
    } catch (e) {
      out.broken.push({ folder: name, error: (e as Error).message });
    }
  }
  out.projects.sort((a, b) => a.examDate.localeCompare(b.examDate) || a.name.localeCompare(b.name));
  return out;
}

export function getProject(core: AppCore, projectId: string): Project {
  return readData(core.paths(projectId).projectJson, Files.project);
}

function validateInput(input: ProjectInput): ProjectInput {
  const parsed = ProjectInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join(' / '));
  const v = parsed.data;
  if (!v.name.trim()) throw new Error('プロジェクト名を入れてください');
  if (!isValidDateString(v.examDate)) throw new Error('試験日が正しい日付ではありません');
  const names = v.subjectNames.map((s) => s.trim()).filter(Boolean);
  if (new Set(names).size !== names.length) throw new Error('同じ科目が2回入っています');
  return { ...v, name: v.name.trim(), subjectNames: names };
}

function uniqueFolder(dir: string, base: string): string {
  let id = base;
  let n = 2;
  while (existsSync(join(dir, id))) id = `${base}-${n++}`;
  return id;
}

/** プロジェクトフォルダの CLAUDE.md(教員としての役割+設定)の内容。 */
export function renderProjectClaudeMd(p: Project): string {
  return renderTemplate(loadPromptFile('project_claude'), {
    name: p.name,
    university: p.university || '(未設定)',
    faculty: p.faculty,
    examDate: p.examDate,
    examType: EXAM_TYPE_LABEL[p.examType],
    targetLevel: TARGET_LEVEL_LABEL[p.targetLevel],
    dailyMinutes: String(p.dailyMinutes),
    subjects: p.subjects.map((s) => s.name).join('、'),
  });
}

/** プロジェクトフォルダ内の .claude/settings.json: このフォルダ内の読み書きだけ許可、コマンド実行なし。 */
export function projectClaudeSettings(): Record<string, unknown> {
  return {
    permissions: {
      allow: ['Read(./**)', 'Edit(./**)', 'Write(./**)'],
      deny: ['Bash', 'PowerShell', 'WebFetch', 'WebSearch'],
    },
  };
}

function ensureSubjectFiles(paths: ProjectPaths, subject: SubjectRef): void {
  const sp = paths.subject(subject.id);
  ensureDir(sp.root);
  for (const d of [sp.sourcesDir, sp.testsDir, sp.notesDir, sp.chatsDir]) ensureDir(d);
  if (!existsSync(sp.unitsJson)) {
    writeData(sp.unitsJson, Files.units, { version: FORMAT_VERSION, tree: initialUnitTree(subject.name), adjustedAt: null, note: '' });
  }
  if (!existsSync(sp.weaknessJson)) {
    writeData(sp.weaknessJson, Files.weakness, { version: FORMAT_VERSION, units: {}, updatedAt: null });
  }
}

/** project.json に合わせて、CLAUDE.md・.claude/settings.json・科目フォルダを作る/更新する。 */
export function writeProjectFiles(paths: ProjectPaths, project: Project): void {
  ensureDir(paths.root);
  ensureDir(paths.logsDir);
  writeData(paths.projectJson, Files.project, project);
  writeFileAtomic(paths.claudeMd, renderProjectClaudeMd(project));
  writeFileAtomic(paths.claudeSettings, JSON.stringify(projectClaudeSettings(), null, 2));
  for (const s of project.subjects) ensureSubjectFiles(paths, s);
}

function subjectsFromNames(names: string[], existing: SubjectRef[]): SubjectRef[] {
  const used = new Set<string>();
  return names.map((name) => {
    const kept = existing.find((s) => s.name === name);
    let id = kept?.id ?? safeFileName(name);
    let n = 2;
    while (used.has(id.toLowerCase())) id = `${safeFileName(name)}-${n++}`;
    used.add(id.toLowerCase());
    return { id, name };
  });
}

export function createProject(core: AppCore, input: ProjectInput): Project {
  const v = validateInput(input);
  const dataDir = core.dataDir();
  ensureDir(dataDir);
  const id = uniqueFolder(dataDir, safeFileName(v.name));
  const now = new Date().toISOString();
  const project: Project = {
    version: FORMAT_VERSION,
    id,
    name: v.name,
    university: v.university.trim(),
    faculty: v.faculty.trim(),
    examDate: v.examDate,
    examType: v.examType,
    targetLevel: v.targetLevel,
    dailyMinutes: v.dailyMinutes,
    subjects: subjectsFromNames(v.subjectNames, []),
    createdAt: now,
    updatedAt: now,
  };
  writeProjectFiles(core.paths(id), project);
  return project;
}

/** 設定を変える。CLAUDE.md も更新する。外した科目のフォルダは消さない(データを守る)。 */
export function updateProject(core: AppCore, projectId: string, input: ProjectInput): Project {
  const v = validateInput(input);
  const current = getProject(core, projectId);
  const project: Project = {
    ...current,
    name: v.name,
    university: v.university.trim(),
    faculty: v.faculty.trim(),
    examDate: v.examDate,
    examType: v.examType,
    targetLevel: v.targetLevel,
    dailyMinutes: v.dailyMinutes,
    subjects: subjectsFromNames(v.subjectNames, current.subjects),
    updatedAt: new Date().toISOString(),
  };
  writeProjectFiles(core.paths(projectId), project);
  return project;
}

export function getSubject(project: Project, subjectId: string): SubjectRef {
  const s = project.subjects.find((x) => x.id === subjectId);
  if (!s) throw new Error(`科目 ${subjectId} はこのプロジェクトにありません`);
  return s;
}
