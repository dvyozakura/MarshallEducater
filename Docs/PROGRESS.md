# PROGRESS(夜間セッション1)

## 経過
- 2026-11-17 21:49〜21:57 overnight.ps1 の呼び出し 1〜14 回目は、Claude の使用量上限(5時間枠)で何もせず終了していた(Logs/overnight.log)。作業は 15 回目から開始。

### 1. M0 基盤(完了)
- git init、Electron + TypeScript + React + Vite の土台。`scripts/build.mjs`(main・preload は esbuild、renderer は vite)で `out/` に出力。
- Tools/ の定型スクリプト 7 本を作成(build_dist.sh・smoke_real.sh は未実装の旨を表示して成功終了。項目21で実装)。
- Vitest(tests/unit)と Playwright(tests/e2e、Electron 起動)の見本テストが通る。
- 環境の点検結果(`./Tools/setup.sh --check-only`):
  - node v24.20.0 / npm 11.19.0 / git 2.56.0.windows.4 / claude 2.1.316 (Claude Code) … すべてあり。不足なし。

### 2. Claude Code の呼び出し方を確認(完了)
- `claude --help` と公式ドキュメントを確認し、DECISIONS.md にまとめた。本物の呼び出しは 2 回(ファイル書き出し、`--resume` での続き)。どちらも成功。

### 1 の気づき
- この環境の npm は導入スクリプトを既定で走らせないため、Electron 本体が入らない。`setup.sh` で `node node_modules/electron/install.js` を補うようにした。

### 3. Claude 呼び出し層とジョブの列(完了)
- runner(子プロセス・時間切れ・取り消し・失敗の見分け)、task(型検証つきのやり直し・logs 保存・1日の上限)、JobQueue(同時実行数・待ち・取り消し・進み具合)、偽 Claude を実装。
- 単体テスト 19 本(成功/やり直して成功/やり直しても失敗/時間切れ/取り消し/上限超過/claude 無し・未ログイン・使用量上限・通信失敗/続きの会話/ジョブの列)。

<!-- END -->
