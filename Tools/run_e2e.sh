#!/usr/bin/env bash
# 偽 Claude での画面を通した自動操作テスト(Playwright で Electron を起動)。
# 使い方: ./Tools/run_e2e.sh [--no-build] [playwright の引数...]
cd "$(dirname "$0")/.." || exit 1
mkdir -p Logs
set -o pipefail
export ME_FAKE_CLAUDE=1
build=1
if [ "$1" = "--no-build" ]; then build=0; shift; fi
{
  if [ $build -eq 1 ]; then
    echo "== ビルド =="
    node scripts/build.mjs || exit 1
  fi
  echo "== 自動操作テスト =="
  npx playwright test "$@" || exit 1
  echo "run_e2e: OK"
} 2>&1 | tee Logs/run_e2e.log
