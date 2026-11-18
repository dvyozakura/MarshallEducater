#!/usr/bin/env node
// 偽 Claude(テスト用)。本物の `claude -p` と同じ引数・標準入力を受け取り、
// プロンプトの種類(ME_PROMPT_KIND)に応じて決まった出力ファイル(ME_OUTPUT_FILE)を書く。
//
// 振る舞いの切り替え:
//   環境変数 ME_FAKE_MODE=<モード>            … すべての呼び出しに同じモード
//   環境変数 ME_FAKE_CONTROL=<JSON ファイル>   … 種類ごと・回数ごとに指定
//     { "default": "ok", "kinds": { "grade": ["broken", "ok"] }, "slowMs": 60000, "options": { ... } }
//     kinds の配列は「その種類の n 回目の呼び出しのモード」。配列が尽きたら default。
// モード: ok / broken(壊れた JSON)/ invalid(型に合わない JSON)/ nofile(何も書かない)/
//         slow(待ってから ok)/ fail(終了コード 1)/ not_logged_in / login_expired(_compact / _text / _exit0)/ usage_limit / network
//         そのほか、種類ごとの応答が解釈するモード(例: solve_problems の wrong)。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { respond } from './responders.mjs';

const argv = process.argv.slice(2);

function readStdin() {
  return new Promise((res) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', () => res(s));
  });
}

function field(prompt, name) {
  const m = prompt.match(new RegExp(`^${name}:[ \\t]*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

function loadControl() {
  const file = process.env.ME_FAKE_CONTROL;
  if (file && existsSync(file)) {
    try {
      return { file, control: JSON.parse(readFileSync(file, 'utf8')) };
    } catch {
      return { file, control: {} };
    }
  }
  return { file: null, control: {} };
}

/** その種類の何回目の呼び出しかを数え、今回のモードを決める。 */
function pickMode(kind) {
  const { file, control } = loadControl();
  const fallback = control.default ?? process.env.ME_FAKE_MODE ?? 'ok';
  const spec = control.kinds?.[kind];
  let mode = fallback;
  if (typeof spec === 'string') mode = spec;
  if (Array.isArray(spec) && file) {
    const stateFile = `${file}.state.json`;
    let state = {};
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch {
      /* 初回 */
    }
    // 制御ファイルが書き換えられたら数え直す
    const stamp = JSON.stringify(control);
    if (state.stamp !== stamp) state = { stamp, counts: {} };
    const n = state.counts[kind] ?? 0;
    state.counts[kind] = n + 1;
    writeFileSync(stateFile, JSON.stringify(state));
    mode = n < spec.length ? spec[n] : fallback;
  }
  return { mode, control };
}

function finish({ result, isError = false, code = 0, sessionId }) {
  const out = {
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError,
    result,
    session_id: sessionId ?? randomUUID(),
    num_turns: 1,
    duration_ms: 1,
    total_cost_usd: 0,
    permission_denials: [],
  };
  process.stdout.write(JSON.stringify(out) + '\n', () => process.exit(code));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (argv.includes('--version')) {
    console.log('0.0.0 (fake-claude)');
    return;
  }
  if (!argv.includes('-p') && !argv.includes('--print')) {
    console.error('fake-claude: -p が必要です');
    process.exit(2);
  }
  const prompt = await readStdin();
  const kind = field(prompt, 'ME_PROMPT_KIND') ?? 'unknown';
  const inputRel = field(prompt, 'ME_INPUT_FILE');
  const outputRel = field(prompt, 'ME_OUTPUT_FILE');
  const resumeIdx = argv.indexOf('--resume');
  const sessionId = resumeIdx >= 0 ? argv[resumeIdx + 1] : randomUUID();
  const { mode, control } = pickMode(kind);

  // 呼び出しの記録(テストが「どの種類が何回呼ばれたか」「プロンプトの中身」を確かめるのに使う)
  if (process.env.ME_FAKE_CONTROL) {
    try {
      const logFile = `${process.env.ME_FAKE_CONTROL}.calls.jsonl`;
      const line = JSON.stringify({ at: new Date().toISOString(), kind, mode, argv, cwd: process.cwd(), prompt }) + '\n';
      writeFileSync(logFile, line, { flag: 'a' });
    } catch {
      /* 記録できなくても続ける */
    }
  }

  if (control.delayMs) await sleep(control.delayMs);

  if (mode === 'fail') {
    console.error('fake-claude: わざと失敗しました');
    process.exit(1);
  }
  if (mode === 'not_logged_in') return finish({ result: 'Not logged in · Please run /login', isError: true, code: 1, sessionId });
  // ログイン切れ(実際に出た文言。ANSWERS.md 1)。_text は JSON でなく素の文で終わる形、_exit0 は終了コード 0 で返答文にだけ出る形。
  const EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed';
  const EXPIRED_COMPACT = 'Prompt is too long · automatic compaction failed: ' + EXPIRED;
  if (mode === 'login_expired') return finish({ result: EXPIRED, isError: true, code: 1, sessionId });
  if (mode === 'login_expired_compact') return finish({ result: EXPIRED_COMPACT, isError: true, code: 1, sessionId });
  if (mode === 'login_expired_text') {
    process.stdout.write(EXPIRED_COMPACT + '\n', ()=> process.exit(1));
    return;
  }
  if (mode === 'login_expired_exit0') return finish({ result: EXPIRED, sessionId });
  if (mode === 'usage_limit') return finish({ result: "You've hit your 5-hour limit · resets 12:30am (Asia/Tokyo)", isError: true, code: 1, sessionId });
  if (mode === 'network') return finish({ result: 'API Error: Connection error. (fetch failed)', isError: true, code: 1, sessionId });
  if (mode === 'slow') await sleep(control.slowMs ?? 60000);

  if (!outputRel) return finish({ result: '(偽 Claude)出力先の指定がありません', sessionId });
  const outFile = resolve(process.cwd(), outputRel);
  mkdirSync(dirname(outFile), { recursive: true });

  if (mode === 'nofile') return finish({ result: '完了', sessionId });
  if (mode === 'broken') {
    writeFileSync(outFile, '{ "ok": tru', 'utf8');
    return finish({ result: '完了', sessionId });
  }
  if (mode === 'invalid') {
    writeFileSync(outFile, JSON.stringify({ unexpected: 1 }), 'utf8');
    return finish({ result: '完了', sessionId });
  }

  let input = null;
  if (inputRel && inputRel !== 'なし') {
    const inFile = resolve(process.cwd(), inputRel);
    if (existsSync(inFile)) input = JSON.parse(readFileSync(inFile, 'utf8'));
  }
  const output = respond({ kind, mode, input, prompt, control, cwd: process.cwd(), sessionId });
  writeFileSync(outFile, typeof output === 'string' ? output : JSON.stringify(output, null, 1), 'utf8');
  finish({ result: '完了', sessionId });
}

main().catch((e) => {
  console.error('fake-claude: 内部エラー', e);
  process.exit(3);
});
