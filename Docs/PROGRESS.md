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

### 4. データの型と保存(完了)
- 全ファイルの型(zod)、検証つきの読み書き、版番号と古い版からの移行、安全な置き換え保存、一時ファイルの掃除。単体テスト 15 本(壊れたファイル、古い版、新しい版、書き込み途中での中断)。

### 5. プロジェクトの作成・編集・一覧(完了)
- 作成・編集・一覧、プロジェクトフォルダの CLAUDE.md と .claude/settings.json の生成・更新。ホーム、作成・編集フォーム、ダッシュボード(最小)。
- 単体テスト 6 本、自動操作テスト 2 本(作成 → 一覧 → 編集 → 再起動後も残る)。

### 6. 科目と単元ツリー(完了)
- 主要 16 科目の初期の単元ツリー(自作の見出しだけ。`src/shared/subjects.ts`)。一覧に無い科目は最小限のツリーから始める。
- Claude による調整(重み 0〜3、追加。既存の ID と名前は保つ)と、手での編集(名前・重み・追加・削除)。「もう一度試す」(同じ種類・同じ引数でジョブを並べ直す)の仕組みもここで入れた。
- 単体テスト 7 本、自動操作テスト 1 本。

<!-- END -->
