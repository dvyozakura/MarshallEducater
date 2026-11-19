# BLOCKERS(進められなかったこと)

## 1. 配布用フォルダ `dist/` を作り直せなかった(セッション3 項目10・11)
- `dist/MarshallEducater-win32-x64/MarshallEducater.exe` が、本物の設定フォルダ(`%APPDATA%\MarshallEducater`)で起動していた(17:40 起動。自動テストは tests/tmp の設定フォルダを使うので、自動テストのものではない)。人が使っていると考え、止めなかった。
- そのため `dist/` は項目7のときのビルドのまま(アイコン入り。中身は項目8〜10の変更より前)。
- 代わりに、同じ形のアプリのフォルダを `release/app/MarshallEducater-win32-x64/` に作り直し、起動・プロジェクトの作成・アイコンを確認した(`node scripts/check-dist.mjs --out release/app`)。インストーラの中身もこれ。
- 再発を防ぐため、`scripts/dist.mjs` は、起動中で名前を変えられないフォルダを消さずに止めるようにした(前は途中まで消しかけていた。確認したところ、起動中のアプリのファイルは消えていなかった)。
- 人がすること: そのアプリを閉じてから `./Tools/build_dist.sh`。
