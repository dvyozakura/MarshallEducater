#!/usr/bin/env bash
# 開発ビルド(out/ に main・preload・renderer を出す)。起動は `npx electron .`。
cd "$(dirname "$0")/.." || exit 1
mkdir -p Logs
set -o pipefail
{
  node scripts/build.mjs || exit 1
  echo "build_dev: OK"
} 2>&1 | tee Logs/build_dev.log
