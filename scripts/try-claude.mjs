// 項目2 の確認用: 本物の claude を非対話で1回だけ呼び、標準出力・終了コード・書かれたファイルを表示する。
// 使い方: node scripts/try-claude.mjs [--resume <session_id>] "<プロンプト>"
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
let resume = null;
if (args[0] === '--resume') {
  resume = args[1];
  args.splice(0, 2);
}
const prompt = args[0] ?? '2+3 の答えを {"answer": 数値} という JSON にして、作業フォルダの out.json に Write ツールで書いてください。書いたら「完了」とだけ答えてください。';
const cwd = resolve('tests/tmp/real-check');
mkdirSync(resolve(cwd, '.claude'), { recursive: true });
writeFileSync(
  resolve(cwd, '.claude/settings.json'),
  JSON.stringify({ permissions: { allow: ['Read(./**)', 'Edit(./**)', 'Write(./**)'], deny: ['Bash', 'WebFetch', 'WebSearch'] } }, null, 2),
);
const cli = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--tools', 'Read,Write,Edit,Glob,Grep', '--model', 'sonnet'];
if (resume) cli.push('--resume', resume);
const started = Date.now();
const child = spawn('claude', cli, { cwd, windowsHide: true });
let out = '';
let err = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (err += d));
child.stdin.end(prompt, 'utf8');
child.on('error', (e) => console.log('spawn error:', e.code, e.message));
child.on('close', (code) => {
  console.log('command: claude ' + cli.join(' ') + '   (prompt は標準入力)');
  console.log('exit code:', code, ' 所要秒:', ((Date.now() - started) / 1000).toFixed(1));
  console.log('stdout:', out.slice(0, 3000));
  console.log('stderr:', err.slice(0, 1000));
  const f = resolve(cwd, 'out.json');
  console.log('out.json:', existsSync(f) ? readFileSync(f, 'utf8') : '(なし)');
});
