import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** 書き込み途中の一時ファイルの名前。読み込み側はこの名前のファイルを無視する。 */
export function tmpPathFor(path: string): string {
  return `${path}.tmp-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 一時ファイルに書いてから置き換える。途中で落ちても、元のファイルは古い内容のまま残る。
 */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  ensureDir(dirname(path));
  const tmp = tmpPathFor(path);
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameWithRetry(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Windows では、ウイルス対策などが一瞬ファイルを掴んで rename が失敗することがあるので少し粘る。 */
function renameWithRetry(from: string, to: string): void {
  let lastError: unknown;
  for (let i = 0; i < 8; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      lastError = e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
    }
  }
  throw lastError;
}

export function readTextIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

/** ファイル名に使えない文字を置き換える(Windows 基準)。 */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (!cleaned || reserved.test(cleaned)) return `_${cleaned}`;
  return cleaned.slice(0, 80);
}

export function newId(prefix: string): string {
  const t = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
  return `${prefix}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}
