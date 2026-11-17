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
