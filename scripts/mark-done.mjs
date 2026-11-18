// 開発の進み具合の更新: TASKS.md の項目 N に印を付け、STATUS.json を書き換える。
// 使い方: node scripts/mark-done.mjs <終わった項目番号> "<次の項目名>" "<一言>"
import { readFileSync, writeFileSync } from 'node:fs';

const [n, current, detail] = process.argv.slice(2);
const done = Number(n);
if (!Number.isInteger(done) || done < 0) {
  console.error('使い方: node scripts/mark-done.mjs <終わった項目番号> <次の項目名> <一言>');
  process.exit(1);
}
let tasks = readFileSync('Docs/TASKS.md', 'utf8');
tasks = tasks.replace(new RegExp(`- \\[ \\] ${done}\\. `), `- [x] ${done}. `);
writeFileSync('Docs/TASKS.md', tasks, 'utf8');
const status = { phase: '夜間セッション2:体系的な教材と、教材への質問', done, total: 7, current: current ?? '', detail: detail ?? '' };
writeFileSync('Docs/STATUS.json', JSON.stringify(status) + '\n', 'utf8');
console.log('STATUS:', JSON.stringify(status));
