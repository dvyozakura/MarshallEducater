#!/usr/bin/env bash
# 型チェック+単体テスト(偽 Claude)。
cd "$(dirname "$0")/.." || exit 1
mkdir -p Logs
set -o pipefail
export ME_FAKE_CLAUDE=1
{
  echo "== 型チェック =="
  npx tsc --noEmit -p tsconfig.json || exit 1
  echo "== 単体テスト =="
  npx vitest run "$@" || exit 1
  echo "run_tests: OK"
} 2>&1 | tee Logs/run_tests.log
