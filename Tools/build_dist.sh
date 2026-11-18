#!/usr/bin/env bash
# 配布用のビルド(インストーラ無しのフォルダ形式)。
# できるもの: dist/MarshallEducater-win32-x64/MarshallEducater.exe(このフォルダごと配る)
# 使い方: ./Tools/build_dist.sh [--no-check]   … --no-check で、できたアプリの起動確認を省く
cd "$(dirname "$0")/.." || exit 1
mkdir -p Logs
set -o pipefail
{
  echo "== ビルド =="
  node scripts/build.mjs || exit 1
  echo "== 配布用フォルダの作成 =="
  node scripts/dist.mjs || exit 1
  if [ "$1" != "--no-check" ]; then
    echo "== 起動の確認 =="
    node scripts/check-dist.mjs || exit 1
  fi
  echo "build_dist: OK"
} 2>&1 | tee Logs/build_dist.log
