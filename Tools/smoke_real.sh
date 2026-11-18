#!/usr/bin/env bash
# 本物の Claude を使う最小の確認: 小さなプロジェクトで、問題を2問作る → 検算 → ダミー答案を採点、まで。
# Claude の呼び出しは多くて5回(アプリの「1日の上限」の仕組みで止める)。使用量を消費するので、必要なときだけ実行する。
# 使い方: ./Tools/smoke_real.sh          … 本物の Claude(claude にログイン済みであること)
#         ./Tools/smoke_real.sh --fake   … 偽 Claude で同じ流れを通す(スクリプトの確認用。本物は呼ばない)
#         ./Tools/smoke_real.sh --textbook        … 教材の最小確認(第1章を作る → 点検 → その章に1回質問。呼び出しは5回まで)
#         ./Tools/smoke_real.sh --textbook --fake … その偽 Claude 版
# データは tests/tmp/smoke-*/ に作る(本番のデータには触れない)。結果は Logs/smoke_real.log にも残す。
cd "$(dirname "$0")/.." || exit 1
mkdir -p Logs
set -o pipefail
if [ "$1" != "--fake" ]; then
  if ! claude --version >/dev/null 2>&1; then
    echo "smoke_real: claude が見つかりません。Claude Code をインストールして、ログインしてから実行してください。"
    exit 1
  fi
fi
node scripts/smoke-real.mjs "$@" 2>&1 | tee Logs/smoke_real.log
