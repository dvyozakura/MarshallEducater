// 公開前の点検(履歴): git の履歴を書き換えずに、(a) コミットの作者名・メールの一覧、(b) 過去のコミットに個人情報らしき文字列が入っているファイル、を調べる。
// 結果は人が判断する(Docs/QUESTIONS.md)。実行: node scripts/check-history.mjs
import { execFileSync } from 'node:child_process';
import { personalWords } from './check-privacy.mjs';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 });

const people = new Set(git(['log', '--all', '--format=%an <%ae>|%cn <%ce>']).split('\n').filter(Boolean).flatMap((l) => l.split('|')));
console.log('== (a) コミットの作者・コミッター(重複なし)==');
for (const p of [...people].sort()) console.log(`- ${p}`);

const words = personalWords();
const patterns = ['[A-Za-z]:[\\\\/]+Users[\\\\/]+[^\\\\/ ]', '/c/Users/[^/ ]', ...words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))];
const revs = git(['rev-list', '--all']).split('\n').filter(Boolean);
const hits = new Map(); // ファイル → { commits, kinds }
for (const rev of revs) {
  for (const pat of patterns) {
    let out = '';
    try {
      out = git(['grep', '-I', '-i', '-l', '-E', pat, rev]);
    } catch {
      continue; // 見つからない(終了コード 1)
    }
    for (const line of out.split('\n').filter(Boolean)) {
      const file = line.slice(rev.length + 1);
      const h = hits.get(file) ?? { commits: new Set(), kinds: new Set() };
      h.commits.add(rev.slice(0, 7));
      h.kinds.add(pat.startsWith('[A-Za-z]') || pat.startsWith('/c/') ? '絶対パス' : 'ユーザー名・作者名');
      hits.set(file, h);
    }
  }
}
console.log(`\n== (b) 過去のコミットで個人情報らしき文字列を含むファイル(${revs.length} コミットを調べた)==`);
if (hits.size === 0) console.log('(なし)');
for (const [file, h] of [...hits.entries()].sort()) console.log(`- ${file}: ${[...h.kinds].join('・')}(${h.commits.size} コミット。例 ${[...h.commits].slice(0, 3).join(', ')})`);
