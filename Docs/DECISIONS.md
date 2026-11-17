# DECISIONS(決めたことの記録)

## 基盤(項目1)
- ビルド: main・preload は esbuild(CJS、electron だけ外部)、renderer は Vite。`scripts/build.mjs` が `out/` に出す。electron-vite などの追加ツールは使わない(依存を少なく)。
- 追加した依存と理由:
  - `electron` / `typescript` / `vite` / `@vitejs/plugin-react` / `react` / `react-dom` … 技術方針どおり。
  - `esbuild` … main・preload のバンドル(Vite が内部で使うものを明示)。
  - `vitest` / `@playwright/test` … 単体テストと、Electron を起動する自動操作テスト。
  - `zod` … データの型の定義と検証。Claude への出力形式の説明(JSON Schema)も同じ型から作る。
  - `katex` / `marked` … 数式と Markdown の表示。
  - `pdfjs-dist` … PDF のページ画像化(renderer の canvas で描く)。テストでは PDF のページ数・文字の確認にも使う。
  - `@electron/packager` … 配布用のフォルダ形式ビルド。
- テスト時の隔離: 環境変数 `ME_DATA_DIR`(データの場所)、`ME_USER_DATA`(Electron の userData)、`ME_HEADLESS=1`(ウィンドウを出さない)で差し替える。自動テストは必ず `tests/tmp/` か OS の一時フォルダを指す。
- 設定ファイル名は `vite.config.mts` / `vitest.config.mts`(Vite 8 の警告を避けるため ESM 拡張子)。

## Claude Code の呼び出し方(項目2、2026-11-17 に確認)
確認元: `claude --help`(版 2.1.316)と公式ドキュメント(code.claude.com/docs/en/headless、cli-reference、permissions)。

### 使うコマンド(方式A)
```
claude -p --output-format json --permission-mode acceptEdits --tools "Read,Write,Edit,Glob,Grep" --model <モデル> [--resume <session_id>]
```
- 作業フォルダ: 子プロセスの cwd をプロジェクトのフォルダにする(Claude は起動したフォルダを主な作業フォルダとして扱う。専用のオプションは無い。追加は `--add-dir`)。
- プロンプト: 標準入力で渡す(`-p` は標準入力を読む。上限 10MB)。引数に長い日本語を載せない(Windows の引数の制約・エスケープを避ける)。
- `--output-format json`: 標準出力に結果 JSON が1つ出る。実測で使える項目: `result`(最後の返答文)、`is_error`、`subtype`("success" など)、`session_id`、`duration_ms`、`num_turns`、`total_cost_usd`、`permission_denials`。ドキュメントに明記があるのは result / session_id / total_cost_usd。
- `--tools`: 使える組み込みツール自体を絞る。Bash・WebFetch などは一覧から消える(「コマンド実行なし」を満たす)。
- `--permission-mode acceptEdits`: ファイルの書き込みを確認なしで行う。`-p` では、許可の無い操作は確認待ちにならず拒否される。
- `--allowedTools` は「確認なしで実行してよいツール」の指定、`--disallowedTools` は拒否の指定。今回は `--tools` で足りるので使わない。
- `--model`: 別名(`sonnet` / `opus` / `haiku` / `fable`)か正式名。アプリの設定で変えられるようにし、既定は `sonnet`(暫定。速さと費用のため)。空なら `--model` を付けない(Claude Code 側の既定)。
- 続きの会話: 結果 JSON の `session_id` を保存し、次回 `--resume <session_id>` を付ける(質問画面で使う)。`--continue` は「そのフォルダの直近の会話」なので、複数のジョブが並ぶこのアプリでは使わない。
- 終了コード: 成功 0、失敗は 0 以外(ドキュメント)。認証が無いなど実行中の失敗は、失敗内容が標準出力の result として出る。
- プロジェクトフォルダの `.claude/settings.json` には `permissions.allow: ["Read(./**)","Edit(./**)","Write(./**)"]`、`deny: ["Bash","WebFetch","WebSearch"]` を書く(二重の守り)。
- ページ画像(PNG)は Claude の Read ツールで読ませる(Read は画像を読める)。

### 実際に試したコマンドと結果(本物の呼び出し 2 回)
1. `node scripts/try-claude.mjs`(中身は上のコマンド。cwd=tests/tmp/real-check、標準入力で「2+3 の答えを {"answer": 数値} として out.json に書け」)
   - 終了コード 0、5.5 秒。stdout は `{"type":"result","subtype":"success","is_error":false,"result":"完了","session_id":"bc97…","num_turns":2,"permission_denials":[],…}`。`out.json` に `{"answer": 5}` が書かれた。
2. `node scripts/try-claude.mjs --resume bc975881-… "さっき書いた answer の値を数字だけで"`
   - 終了コード 0、2.2 秒。`result: "5"`、同じ `session_id` が返った(会話の続きができる)。

### 失敗の見分け方(暫定)
- claude が無い: 子プロセスの起動が `ENOENT` で失敗する。
- 使用量の上限: 実例(Logs/overnight.log、テキスト出力)は `You've hit your 5-hour limit · resets 12:30am (Asia/Tokyo)`。標準出力・標準エラー・result に `hit your … limit` / `usage limit` / `limit reached` を含むかで判定する。
- 未ログイン: ドキュメントに決まった文言は無い。`Not logged in` / `Please run /login` / `Invalid API key` / `authentication` を含むかで判定する(実物を確認できていないので QUESTIONS.md に記載)。
- 通信失敗: `ECONNRESET` / `ENOTFOUND` / `network` / `fetch failed` / `API Error` / `overloaded` などを含むか。
- どれでもなければ「その他の失敗」として、出力の先頭を画面に出す。
