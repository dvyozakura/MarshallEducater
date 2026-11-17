import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ClaudeSettings } from '../../src/core/claude/runner';

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
