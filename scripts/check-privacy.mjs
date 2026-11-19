// 公開前の点検: git で管理しているファイルから、個人情報らしき文字列を探す。
//   - Windows のユーザーのフォルダの絶対パス(C:\Users\名前\…、/c/Users/名前/…)
//   - この PC のユーザー名・git の作者名とメール(実行した PC から読む。ファイルには書かない)
//   - メールアドレス(許可したもの以外)
//   - 秘密の値らしきもの(API キー・トークンの形)
// 使い方: node scripts/check-privacy.mjs   … 見つかったら一覧を出して終了コード 1(npm run check:privacy)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 中身を調べないファイル(画像・PDF など)。 */
const BINARY = new Set(['.png', '.ico', '.jpg', '.jpeg', '.gif', '.pdf', '.woff', '.woff2', '.ttf', '.exe']);
/** 書いてあってよいメールアドレス(コミットの署名・例示用)。 */
const ALLOWED_EMAILS = [/^noreply@anthropic\.com$/i, /@example\.(com|org|net|jp)$/i, /^git@github\.com$/i];

function gitOut(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** この PC から、個人を指す語を集める(ファイルには書かない)。 */
export function personalWords(env = process.env) {
  const words = new Set();
  const add = (w) => {
    const t = (w ?? '').trim();
    if (t.length >= 3) words.add(t);
  };
  try {
    add(userInfo().username);
  } catch {
    /* 取れない環境 */
  }
  if (env.USERPROFILE) add(basename(env.USERPROFILE));
  if (env.USERNAME) add(env.USERNAME);
  add(gitOut(['config', 'user.name']));
  add(gitOut(['config', 'user.email']));
  // 姓・名の片方だけ(「名前 苗字」の形のとき)
  for (const w of [...words]) for (const part of w.split(/[\s._-]+/)) if (part.length >= 4) words.add(part);
  return [...words];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 1つの文章から、個人情報らしき箇所を探す。 */
export function findIssues(text, words = [], opts = {}) {
  const issues = [];
  const lines = text.split(/\r?\n/);
  const wordRe = words.length ? new RegExp(words.map(escapeRe).join('|'), 'i') : null;
  lines.forEach((line, i) => {
    // わざと書いた例(点検のテストのデータなど)は、行末の目印で飛ばす
    if (line.includes('check-privacy: ignore')) return;
    const at = (kind, match) => {
      if (opts.allowEmails && kind === 'メールアドレス') return;
      issues.push({ line: i + 1, kind, match: match.slice(0, 80) });
    };
    for (const m of line.matchAll(/[A-Za-z]:[\\/]+Users[\\/]+([^\\/<>"'`\s]+)/gi)) {
      if (!/^(<[^>]*>|%[A-Z]+%|\$\{?\w+\}?|\.\.\.|…|Public|Default|名前|ユーザー名|you|user|USERNAME)$/i.test(m[1])) at('ユーザーのフォルダの絶対パス', m[0]);
    }
    for (const m of line.matchAll(/\/(?:c|mnt\/c)\/Users\/([^/<>"'`\s]+)/gi)) {
      if (!/^(<[^>]*>|\$\{?\w+\}?|\[.*|\(.*|名前|ユーザー名|user)$/i.test(m[1])) at('ユーザーのフォルダの絶対パス', m[0]);
    }
    for (const m of line.matchAll(/(?<![\w.@/-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g)) {
      if (!ALLOWED_EMAILS.some((re) => re.test(m[0]))) at('メールアドレス', m[0]);
    }
    if (wordRe) {
      const m = line.match(wordRe);
      if (m) at('この PC のユーザー名・git の作者', m[0]);
    }
    for (const m of line.matchAll(/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abp]-[A-Za-z0-9-]{20,})\b/g)) at('秘密の値らしきもの', m[0]);
  });
  return issues;
}

/** git で管理しているファイルをすべて調べる。 */
export function scanRepo() {
  const files = gitOut(['ls-files', '-z']).split('\0').filter(Boolean);
  const words = personalWords();
  const found = [];
  for (const f of files) {
    if (BINARY.has(extname(f).toLowerCase())) continue;
    let text;
    try {
      text = readFileSync(resolve(root, f), 'utf8');
    } catch {
      continue; // 消したがまだコミットしていないファイルなど
    }
    // THIRD_PARTY_NOTICES.md は、ほかの人のライセンスの本文(作者の公開のメールを含む)をそのまま写したもの
    for (const issue of findIssues(text, words, { allowEmails: f === 'THIRD_PARTY_NOTICES.md' })) found.push({ file: f, ...issue });
  }
  return { files: files.length, found };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, found } = scanRepo();
  for (const x of found) console.log(`${x.file}:${x.line}  [${x.kind}]  ${x.match}`);
  console.log(found.length ? `check-privacy: ${found.length} 件(${files} ファイルを調べた)` : `check-privacy: OK(${files} ファイルを調べ、0 件)`);
  process.exit(found.length ? 1 : 0);
}
