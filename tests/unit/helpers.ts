import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AppCore } from '../../src/core/app';
import { createApi, type Api } from '../../src/core/api';
import type { ClaudeSettings } from '../../src/core/claude/runner';
import type { JobInfo } from '../../src/shared/jobs';
import type { ProjectInput, SourceKind } from '../../src/shared/schema';

export const repoRoot = resolve(__dirname, '../..');

/** テスト用の一時フォルダ(リポジトリ内 tests/tmp の下)。 */
export function makeTmpDir(prefix = 'unit-'): string {
  const base = join(repoRoot, 'tests', 'tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

export interface FakeHandle {
  settings: ClaudeSettings;
  controlFile: string;
  set: (control: unknown) => void;
  /** 偽 Claude が受けた呼び出しの記録。 */
  calls: () => Array<{ kind: string; mode: string; prompt: string; argv: string[] }>;
}

/** 偽 Claude を使う設定を作る。control で振る舞いを指定できる。 */
export function fakeClaude(dir: string, control: unknown = {}, timeoutMs = 20000): FakeHandle {
  const controlFile = join(dir, `fake-control-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(controlFile, JSON.stringify(control), 'utf8');
  return {
    controlFile,
    settings: {
      claudePath: '',
      model: '',
      timeoutMs,
      extraEnv: { ME_FAKE_CLAUDE: '1', ME_FAKE_CONTROL: controlFile, ME_FAKE_CLAUDE_PATH: join(repoRoot, 'Tools/fake-claude/fake-claude.mjs') },
    },
    set: (c) => writeFileSync(controlFile, JSON.stringify(c), 'utf8'),
    calls: () => {
      const f = `${controlFile}.calls.jsonl`;
      if (!existsSync(f)) return [];
      return readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    },
  };
}

export interface TestCore {
  dir: string;
  core: AppCore;
  api: Api;
  fake: FakeHandle;
}

/** 偽 Claude・一時フォルダで動くアプリの中心部を作る(Electron なし)。 */
export function makeCore(control: unknown = {}, dir = makeTmpDir('core-')): TestCore {
  const fake = fakeClaude(dir, control);
  const core = new AppCore({
    userDataDir: join(dir, 'userData'),
    defaultDataDir: join(dir, 'data'),
    envDataDir: join(dir, 'data'),
    extraEnv: fake.settings.extraEnv,
    // 本物は Electron の機能で切り出す。テストでは「切り出したことにする」
    cropImage: (src, _bbox, out) => {
      mkdirSync(dirname(out), { recursive: true });
      copyFileSync(src, out);
    },
  });
  return { dir, core, api: createApi(core), fake };
}

/** 中身は何でもよい、PNG の形をしたダミー。 */
export function fakePng(size = 200): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
}

/** ダミーのページ画像で、資料を1つ取り込んだことにする。 */
export function importFake(t: TestCore, projectId: string, subjectId: string, pages: number, kind: SourceKind = 'past_exam', title = 'ダミー資料', testId?: string): string {
  const meta = t.api.importBegin(projectId, subjectId, { kind, title, fileName: 'dummy.pdf', testId: testId ?? null });
  for (let n = 1; n <= pages; n++) t.api.importPage(projectId, subjectId, meta.id, n, fakePng(), n === 1 ? '第1問' : undefined);
  t.api.importFinish(projectId, subjectId, meta.id, pages);
  return meta.id;
}

/** ジョブが終わるまで待ち、完了していなければテストを失敗させる。 */
export async function done(t: TestCore, job: JobInfo): Promise<JobInfo> {
  const info = await t.core.jobs.wait(job.id);
  if (info.status !== 'done') throw new Error(`ジョブ「${info.title}」が ${info.status}: ${info.error?.kind} ${info.error?.message}`);
  return info;
}

/** ジョブが終わるまで待つ(失敗でも例外にしない)。 */
export function settled(t: TestCore, job: JobInfo): Promise<JobInfo> {
  return t.core.jobs.wait(job.id);
}

export const sampleInput: ProjectInput = {
  name: 'テスト大学 理学部',
  university: 'テスト大学',
  faculty: '理学部',
  examDate: '2027-02-25',
  examType: 'kokkoritsu',
  targetLevel: 'solid',
  dailyMinutes: 180,
  subjectNames: ['数学II・B・C', '英語リーディング'],
};
