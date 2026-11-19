// 教員エンジンごとの呼び方(DECISIONS.md「ほかの AI との接続」)。
// - Claude Code: `claude -p`(今までどおり。入出力はファイル、Read/Write/Edit/Glob/Grep だけ許可)
// - ChatGPT(Codex CLI): `codex exec`。読み取り専用のサンドボックス+シェルのツールを切り、入力はプロンプトに埋め込み、
//   最後の返答(JSON)を -o でファイルに書かせる。画像は -i で添付する。
// - Gemini(Gemini CLI): `gemini -p`。承認モード default(書き込み・コマンドは非対話では拒否される)、
//   プロジェクトの .gemini/settings.json でシェルのツールを外す。入力はプロンプトに埋め込み、返答の JSON(--output-format json の response)を使う。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { ENGINE_COMMAND, type EngineId } from '../../shared/engines';

export interface Invocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Codex CLI の引数。プロンプトは標準入力(`-`)。 */
export function codexArgs(o: { cwd: string; model: string; images: string[]; lastMessageFile: string }): string[] {
  const args = [
    'exec',
    '--skip-git-repo-check',
    '-C',
    o.cwd,
    // 読み取り専用(ファイルの書き込みも、コマンドでの書き込みもさせない)
    '-s',
    'read-only',
    // シェル(コマンド実行)のツールを使わせない
    '-c',
    'features.shell_tool=false',
    '-c',
    'approval_policy="never"',
    '-o',
    o.lastMessageFile,
  ];
  if (o.model.trim()) args.push('-m', o.model.trim());
  for (const img of o.images) args.push('-i', img);
  args.push('-');
  return args;
}

/** Gemini CLI の引数。プロンプトの本体は標準入力。-p の文は標準入力のあとに足される。 */
export function geminiArgs(o: { model: string }): string[] {
  const args = ['--output-format', 'json', '--approval-mode', 'default'];
  if (o.model.trim()) args.push('-m', o.model.trim());
  args.push('-p', '上の指示に従い、最後の返答として JSON だけを書いてください。');
  return args;
}

/** プロジェクトのフォルダに置く Gemini CLI の設定(シェルのツールを外す)。 */
export function geminiProjectSettings(): Record<string, unknown> {
  return {
    tools: {
      core: ['read_file', 'read_many_files', 'list_directory', 'glob', 'search_file_content'],
      exclude: ['run_shell_command', 'write_file', 'replace', 'web_fetch', 'google_web_search'],
    },
  };
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * npm で入れたコマンド(Windows では .cmd の小さな起動用ファイル)は、そのままでは子プロセスとして起動できないので、
 * 中に書かれている本体の .js を node で動かす。
 */
export function resolveNpmShim(cmdFile: string): string | null {
  try {
    const text = readFileSync(cmdFile, 'utf8');
    const m = text.match(/"%(?:~)?dp0%\\?([^"]+?\.(?:js|mjs|cjs))"/i);
    if (!m) return null;
    const js = join(dirname(cmdFile), m[1].replace(/^\\/, ''));
    return existsSync(js) ? js : null;
  } catch {
    return null;
  }
}

/** PATH からコマンドを探す(Windows では .exe → .cmd の順)。 */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = join(d, name + e);
      if (isFile(p)) return p;
    }
  }
  return null;
}

/**
 * PATH に無いときに探すフォルダ(npm・pnpm・bun・volta・scoop・~/.local/bin など、ユーザー単位で入れたときの置き場所)。
 * アプリをエクスプローラーやスタートメニューから起動すると、ターミナルで足した PATH が入っていないことがあるため。
 */
export function extraSearchDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.USERPROFILE || env.HOME || homedir();
  const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
  const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const dirs =
    process.platform === 'win32'
      ? [
          join(appData, 'npm'),
          ...(env.npm_config_prefix ? [env.npm_config_prefix] : []),
          join(home, '.local', 'bin'),
          join(local, 'pnpm'),
          join(home, '.bun', 'bin'),
          join(local, 'Volta', 'bin'),
          join(home, 'scoop', 'shims'),
          join(local, 'Microsoft', 'WinGet', 'Links'),
          join(local, 'Microsoft', 'WindowsApps'),
          join(env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
        ]
      : [join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', join(home, '.bun', 'bin')];
  return [...new Set(dirs)];
}

/** PATH → 追加のフォルダ、の順に探す。tried に探した場所を残す(見つからないときの案内用)。 */
export function findCommand(name: string, env: NodeJS.ProcessEnv = process.env, tried: string[] = []): string | null {
  const onPath = findOnPath(name, env);
  tried.push(`PATH(${(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).length} 個のフォルダ)`);
  if (onPath) return onPath;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const d of extraSearchDirs(env)) {
    tried.push(d);
    for (const e of exts) {
      const p = join(d, name + e);
      if (isFile(p)) return p;
    }
  }
  return null;
}

/** エンジンのコマンドがどこにあるか(設定画面の「探した場所」)。 */
export function locateEngine(engine: EngineId, configured: string, env: NodeJS.ProcessEnv = process.env): { path: string | null; tried: string[]; configHome: string | null } {
  const tried: string[] = [];
  const want = configured.trim();
  let path: string | null = null;
  if (want) {
    const abs = isAbsolute(want) ? want : resolve(want);
    tried.push(`設定の場所: ${want}`);
    path = isFile(abs) ? abs : want.includes('\\') || want.includes('/') ? null : findCommand(want, env, tried);
  }
  if (!path) path = findCommand(ENGINE_COMMAND[engine], env, tried);
  const home = env.USERPROFILE || env.HOME || homedir();
  const cfg = engine === 'codex' ? join(home, '.codex') : engine === 'gemini' ? join(home, '.gemini') : join(home, '.claude');
  return { path, tried, configHome: existsSync(cfg) ? cfg : null };
}

/**
 * 起動するコマンドを決める。.js なら node で、.cmd なら中の本体の .js を node で動かす。
 * 見つからないときは名前のまま返す(起動に失敗して「入っていません」になる)。
 */
export function resolveEngineCommand(engine: EngineId, configured: string, env: NodeJS.ProcessEnv): { command: string; prefix: string[]; env: NodeJS.ProcessEnv } {
  const want = configured.trim();
  const path = locateEngine(engine, want, env).path;
  if (!path) return { command: want || ENGINE_COMMAND[engine], prefix: [], env };
  const lower = path.toLowerCase();
  const asNode = (js: string) => ({ command: process.execPath, prefix: [js], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } });
  if (/\.(js|mjs|cjs)$/.test(lower)) return asNode(path);
  if (/\.(cmd|bat)$/.test(lower)) {
    const js = resolveNpmShim(path);
    if (js) return asNode(js);
  }
  return { command: path, prefix: [], env };
}

/** 返答の文から JSON を取り出す(コードブロックで囲まれていても、前後に説明が付いていても)。 */
export function extractJsonText(text: string): string | null {
  let t = text.trim();
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  if (!t) return null;
  const fenced = t.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenced) t = fenced[1].trim();
  try {
    JSON.parse(t);
    return t;
  } catch {
    /* 前後に文がある */
  }
  const first = t.indexOf('{');
  if (first < 0) return null;
  const last = t.lastIndexOf('}');
  // 壊れた JSON も、そのまま書いて型の検証でやり直させる(エラー内容を添えるため)
  return last > first ? t.slice(first, last + 1) : t.slice(first);
}

/** Gemini CLI の --output-format json の結果。 */
export function parseGeminiJson(stdout: string): { response?: string; error?: string } | null {
  const t = stdout.trim();
  if (!t) return null;
  const first = t.indexOf('{');
  if (first < 0) return null;
  try {
    const v = JSON.parse(t.slice(first));
    const err = v?.error ? (typeof v.error === 'string' ? v.error : [v.error.type, v.error.code, v.error.message].filter(Boolean).join(' ')) : undefined;
    return { response: typeof v?.response === 'string' ? v.response : undefined, error: err };
  } catch {
    return null;
  }
}
