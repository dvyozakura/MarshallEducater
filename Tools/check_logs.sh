#!/usr/bin/env bash
# 直近のテスト・ビルドのログ(Logs/*.log)から、エラーらしい行を抜き出して表示する。
cd "$(dirname "$0")/.." || exit 1
found=0
for f in Logs/run_tests.log Logs/run_e2e.log Logs/build_dev.log Logs/build_dist.log Logs/smoke_real.log; do
  [ -f "$f" ] || continue
  hits=$(grep -n -i -E "error|失敗|FAIL|✘|×|Unhandled|Cannot find|TS[0-9]{4}" "$f" | grep -v -i -E "0 failed|no errors" | head -n 40)
  if [ -n "$hits" ]; then
    found=1
    echo "== $f =="
    echo "$hits"
  fi
done
if [ $found -eq 0 ]; then echo "check_logs: エラーは見つかりませんでした"; fi
exit 0
