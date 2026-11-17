import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Files, readData } from '../../src/core/store';
import { makeCore, sampleInput } from './helpers';

describe('プロジェクトの作成・編集・一覧', () => {
  it('作成すると、フォルダ・project.json・CLAUDE.md・.claude/settings.json・科目フォルダができる', () => {
    const { api, core } = makeCore();
    const p = api.createProject(sampleInput);
    expect(p.id).toBe('テスト大学 理学部');
    const paths = core.paths(p.id);
    expect(readData(paths.projectJson, Files.project).subjects.map((s) => s.name)).toEqual(['数学II・B・C', '英語リーディング']);
    const md = readFileSync(paths.claudeMd, 'utf8');
    expect(md).toContain('専任の教員');
    expect(md).toContain('テスト大学 理学部');
    expect(md).toContain('2027-02-25');
    expect(md).toContain('国公立二次');
    expect(md).toContain('180 分');
    const settings = JSON.parse(readFileSync(paths.claudeSettings, 'utf8'));
    expect(settings.permissions.allow).toEqual(['Read(./**)', 'Edit(./**)', 'Write(./**)']);
    expect(settings.permissions.deny).toContain('Bash');
    const units = readData(paths.subject('数学II・B・C').unitsJson, Files.units);
    expect(units.tree.length).toBeGreaterThan(5);
    expect(existsSync(paths.subject('英語リーディング').weaknessJson)).toBe(true);
  });

  it('一覧に出る。同じ名前は別のフォルダになる。壊れたフォルダは分けて報告する', () => {
    const { api, core } = makeCore();
    const a = api.createProject(sampleInput);
    const b = api.createProject(sampleInput);
    expect(b.id).not.toBe(a.id);
    mkdirSync(join(core.dataDir(), 'こわれた'), { recursive: true });
    writeFileSync(join(core.dataDir(), 'こわれた', 'project.json'), '{ oops', 'utf8');
    const list = api.listProjects();
    expect(list.projects.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(list.broken).toHaveLength(1);
    expect(list.broken[0].folder).toBe('こわれた');
  });

  it('編集すると project.json と CLAUDE.md が更新される。科目の追加・削除ができ、外した科目のフォルダは残る', () => {
    const { api, core } = makeCore();
    const p = api.createProject(sampleInput);
    const q = api.updateProject(p.id, { ...sampleInput, examDate: '2027-03-10', targetLevel: 'top', dailyMinutes: 240, subjectNames: ['数学II・B・C', '化学'] });
    expect(q.id).toBe(p.id);
    expect(q.createdAt).toBe(p.createdAt);
    const paths = core.paths(p.id);
    const md = readFileSync(paths.claudeMd, 'utf8');
    expect(md).toContain('2027-03-10');
    expect(md).toContain('上位での合格をねらう');
    expect(md).toContain('240 分');
    expect(md).toContain('化学');
    expect(md).not.toContain('英語リーディング');
    expect(existsSync(paths.subject('化学').unitsJson)).toBe(true);
    expect(existsSync(paths.subject('英語リーディング').unitsJson)).toBe(true);
  });

  it('入力の誤りは日本語で断る', () => {
    const { api } = makeCore();
    expect(() => api.createProject({ ...sampleInput, name: '  ' })).toThrow('プロジェクト名');
    expect(() => api.createProject({ ...sampleInput, examDate: '2027-02-30' })).toThrow('試験日');
    expect(() => api.createProject({ ...sampleInput, subjectNames: [] })).toThrow('科目');
    expect(() => api.createProject({ ...sampleInput, subjectNames: ['数学', '数学'] })).toThrow('同じ科目');
  });

  it('ファイル名に使えない文字を含む名前でも作れる', () => {
    const { api, core } = makeCore();
    const p = api.createProject({ ...sampleInput, name: 'A/B大学: 理*学?部', subjectNames: ['物理/化学'] });
    expect(existsSync(core.paths(p.id).projectJson)).toBe(true);
    expect(p.name).toBe('A/B大学: 理*学?部');
    expect(p.subjects[0].name).toBe('物理/化学');
    expect(existsSync(core.paths(p.id).subject(p.subjects[0].id).unitsJson)).toBe(true);
  });

  it('設定は保存され、作り直しても残る。同時実行数などの範囲を守る', () => {
    const t = makeCore();
    t.api.updateSettings({ concurrency: 3, dailyLimit: 50, model: 'opus' });
    const again = makeCore({}, t.dir);
    expect(again.api.getSettings()).toMatchObject({ concurrency: 3, dailyLimit: 50, model: 'opus' });
    expect(() => t.api.updateSettings({ concurrency: 0 })).toThrow();
  });
});
