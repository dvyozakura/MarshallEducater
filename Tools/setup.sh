#!/usr/bin/env bash
# 依存の導入(npm ci)と環境の点検(node・git・claude の有無と版)。
# 使い方: ./Tools/setup.sh [--check-only]
cd "$(dirname "$0")/.." || exit 1
mkdir -p Logs

status=0
check() {
  local name="$1"
  local ver
  if ver=$("$name" --version 2>/dev/null | head -n 1); then
    echo "OK   $name: $ver"
  else
    echo "NG   $name: 見つかりません"
    status=1
  fi
}

echo "== 環境の点検 =="
check node
check npm
check git
check claude

# 任意: ChatGPT(Codex CLI)。無くてもアプリは Claude だけで動くので、NG にはしない。
# Git Bash の PATH に無くても、Windows で npm を使って入れた場所(%APPDATA%\npm)を見る。
codex_ver=""
if command -v codex >/dev/null 2>&1; then
  codex_ver=$(codex --version 2>/dev/null | head -n 1)
elif [ -n "$APPDATA" ] && [ -f "$APPDATA/npm/codex.cmd" ]; then
  codex_ver="$(cmd.exe //d //c "$APPDATA\\npm\\codex.cmd" --version 2>/dev/null | head -n 1)($APPDATA\\npm\\codex.cmd)"
fi
if [ -n "$codex_ver" ]; then echo "OK   codex(任意): $codex_ver"; else echo "--   codex(任意): 見つかりません(ChatGPT を使わないなら不要)"; fi

if [ "$1" != "--check-only" ]; then
  echo "== 依存の導入 (npm ci) =="
  npm ci || status=1
  # npm の設定によっては electron の導入スクリプトが走らないので、本体が無ければ取得する
  if [ ! -d node_modules/electron/dist ]; then
    echo "== Electron 本体の取得 =="
    node node_modules/electron/install.js || status=1
  fi
fi

if [ $status -eq 0 ]; then echo "setup: OK"; else echo "setup: 不足があります(上の NG を確認)"; fi
exit $status
