import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findCommand, locateEngine, resolveEngineCommand } from '../../src/core/claude/engines';
import { makeTmpDir } from './helpers';

/** npm で入れたときと同じ形の codex.cmd(中の本体は node_modules/@openai/codex/bin/codex.js)を置く。 */
function fakeNpmCodex(npmDir: string): string {
  mkdirSync(join(npmDir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
  writeFileSync(join(npmDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), 'console.log("codex-cli 0.0.0")');
  const cmd = join(npmDir, 'codex.cmd');
  writeFileSync(cmd, '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  return cmd;
}

describe.runIf(process.platform === 'win32')('エンジンのコマンドの探し方(Windows)', () => {
  it('PATH に無くても、%APPDATA%\\npm にあれば見つける(エクスプローラーから起動したとき)', () => {
    const home = makeTmpDir('locate-');
    const appData = join(home, 'AppData', 'Roaming');
    const cmd = fakeNpmCodex(join(appData, 'npm'));
    mkdirSync(join(home, '.codex'), { recursive: true });
    const env = { PATH: join(home, 'empty'), APPDATA: appData, LOCALAPPDATA: join(home, 'AppData', 'Local'), USERPROFILE: home };
    const tried: string[] = [];
    expect(findCommand('codex', env, tried)).toBe(cmd);
    expect(tried[0]).toContain('PATH');
    const loc = locateEngine('codex', '', env);
    expect(loc.path).toBe(cmd);
    expect(loc.configHome).toBe(join(home, '.codex'));
    // .cmd の中の本体(.js)を node で動かす
    const r = resolveEngineCommand('codex', '', env);
    expect(r.prefix[0]).toBe(join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    expect(r.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('見つからなければ null と、探した場所の一覧(~/.local/bin・%APPDATA%\\npm など)', () => {
    const home = makeTmpDir('locate-');
    const env = { PATH: join(home, 'empty'), APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), USERPROFILE: home };
    const loc = locateEngine('codex', '', env);
    expect(loc.path).toBeNull();
    expect(loc.tried).toContain(join(home, 'AppData', 'Roaming', 'npm'));
    expect(loc.tried).toContain(join(home, '.local', 'bin'));
    expect(loc.configHome).toBeNull();
  });

  it('設定で場所を手で指定できる(PATH・既定の場所より優先)', () => {
    const home = makeTmpDir('locate-');
    const cmd = fakeNpmCodex(join(home, 'somewhere'));
    const env = { PATH: join(home, 'empty'), APPDATA: join(home, 'x'), LOCALAPPDATA: join(home, 'y'), USERPROFILE: home };
    expect(locateEngine('codex', cmd, env).path).toBe(cmd);
    expect(locateEngine('codex', join(home, 'no-such.cmd'), env).path).toBeNull();
  });
});
