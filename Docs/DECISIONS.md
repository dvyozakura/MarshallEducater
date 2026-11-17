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

## Claude 呼び出し層とジョブ(項目3)
- 構成: `src/core/claude/runner.ts`(子プロセス1回ぶん)→ `task.ts`(入出力ファイル・型検証・やり直し・記録)→ `src/core/jobs.ts`(ジョブの列)。`src/core/` は Electron に依存させず、Vitest から直接テストする。
- 受け渡しの置き場所: プロジェクト内 `.me/io/<呼び出しID>/input.json`・`output.json`。成功したら消す(内容は logs に残る)。
- プロンプトの約束: 本文(`src/prompts/<種類>.md`)の後ろに共通の `_common.md` を付ける。そこに `ME_PROMPT_KIND:` `ME_INPUT_FILE:` `ME_OUTPUT_FILE:` の3行と、型(zod)から作った JSON Schema を入れる。やり直しのときは `_retry.md`(前回のエラー内容)を足す。
- やり直しは「出力ファイルが無い・JSON として読めない・型に合わない・追加の検査に落ちた」ときだけ(最大2回)。claude 自体の失敗(未ログイン・上限・時間切れ・取り消しなど)はやり直さず、すぐ失敗にする。
- 記録: 呼び出し1回ごとに `logs/<呼び出しID>_<種類>_<何回目>.json`(プロンプト全文・所要時間・終了コード・結果・検証エラー)。
- 1日の上限: データフォルダ直下の `usage.json`(日付と回数)で数える。やり直しも1回と数える。端末の日付が変わると 0 に戻る。
- 1回の呼び出しの制限時間: 既定 15 分(暫定、設定で変更可)。時間切れ・取り消しのときは Windows では `taskkill /T /F` で子プロセスごと止める。
- ジョブはメモリ上だけで持つ(アプリを閉じると一覧は消える。結果はファイルに残っているので困らない)。暫定。
- 偽 Claude: `Tools/fake-claude/fake-claude.mjs`。`ME_FAKE_CLAUDE=1` のとき、アプリは自分自身の実行ファイル(Electron なら `ELECTRON_RUN_AS_NODE=1`)でこのスクリプトを動かす。振る舞いは `ME_FAKE_MODE`(全体)か `ME_FAKE_CONTROL`(JSON ファイル。種類ごと・回数ごと)で切り替える。モード: ok / broken / invalid / nofile / slow / fail / not_logged_in / usage_limit / network、制御ファイルの `notFound: true` で「claude が無い」。受けた呼び出しは `<制御ファイル>.calls.jsonl` に記録され、テストがプロンプトの中身を確かめられる。

## データの型と保存(項目4)
- 型は `src/shared/schema.ts` に zod でまとめる(ファイルの形と、Claude の出力の形の両方)。ファイルの種類の一覧は `src/core/store.ts` の `Files`、置き場所は `src/core/paths.ts`。
- 版番号: すべての JSON ファイルの先頭階層に `version`(いまは全種類 1)。読み込み時に、古い版は `migrations` で1つずつ直し、直した内容で書き戻す(元は `<ファイル>.v<版>.bak`)。アプリより新しい版は読まずにエラー(書き換えない)。版番号が無いものは版 0 とみなす。
- 壊れたファイルは消さずに残し、種類(壊れている/形式違い/新しい版/古すぎる版)を分けて日本語で伝える。
- 保存は「一時ファイル(`<名前>.tmp-<pid>-<乱数>`)に書いて fsync → rename で置き換え」。Windows で rename が一時的に失敗(EPERM/EBUSY)したら少し待って数回やり直す。残った一時ファイルは起動時に掃除する(1分以上前のものだけ)。
- フォルダ名: プロジェクト ID・科目 ID は名前からファイル名に使えない文字を除いたもの(人がフォルダを見て分かるように)。同名があれば `-2` などを付ける。名前を後から変えてもフォルダ名(ID)は変えない。
- CLAUDE.md の構成に足したファイル(細部): 資料ごとの `source.json`(種類・題名・状態)、`extracted.original.json`(Claude が最初に読んだまま。補正率の計算用)、`figures/`(切り出した図)、科目ごとの `review.json`(復習の予定)、テストごとの `explanations.json`・`booklet.pdf`・`answer_sheet.pdf`、プロジェクト直下の `.me/io/`(受け渡しの一時置き場)、データフォルダ直下の `usage.json`。紙の答案 `tests/<ID>/submission/` は資料と同じ構成(original.pdf、pages/、extracted.json、corrections.json)。
- 難易度の設定は2つに分けた: 試験の型(共通テスト/国公立二次/私大)と、目標の高さ(合格最低点をねらう/合格者平均をねらう/上位での合格をねらう)。暫定。

## プロジェクトと画面の窓口(項目5)
- 画面 → main の窓口は IPC `me:call`(機能名+引数)1本だけ。使える機能は `src/core/api.ts` の `createApi()` が返す一覧に限る(一覧に無い名前は断る)。main → 画面の知らせは `me:event`(ジョブの変化)。`createApi` は Electron に依存しないので、単体テストから同じ入口を呼べる。
- プロジェクトの CLAUDE.md のひな形は `src/prompts/project_claude.md`。設定を保存するたびに書き直す。
- プロジェクトの `.claude/settings.json`: allow `Read(./**)` `Edit(./**)` `Write(./**)`、deny `Bash` `PowerShell` `WebFetch` `WebSearch`。
- 科目を外しても科目フォルダは消さない(データを守る)。プロジェクトの削除機能は作っていない(エクスプローラーでフォルダを消す)。暫定。
- 自動操作テストのウィンドウ: 完全に隠す(show:false)と描画が止まり Playwright の操作が1回ごとに数秒かかったため、`ME_HEADLESS=1` のときは画面の外(-20000,-20000)に、フォーカスを取らない形で出す。
- テスト用に、今日の日付は環境変数 `ME_TODAY` で差し替えられる。

## 単元ツリー(項目6)
- 単元は `{id, name, weight, children}`。重みは 0=扱わない、1=ふつう、2=重点、3=最重点。出題の対象は「葉で、自分と親の重みが 0 でない単元」。階層は3段まで。
- 初期ツリーの ID は位置から決める(`u01`、`u01-02`)。Claude の調整では、既存の ID と名前を変えないことをプロンプトで求め、出力の ID の重なり・空の名前は検査してやり直させる。苦手マップなどの記録は単元 ID で結び付ける。
- 初期ツリーは、科目の構成を参考に見出しだけを自作したもの(教科書の文章は使っていない)。

<!-- END -->
