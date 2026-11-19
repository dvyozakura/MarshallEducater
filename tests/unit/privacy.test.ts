import { describe, expect, it } from 'vitest';
// @ts-expect-error JavaScript のスクリプト(型なし)
import { findIssues, scanRepo } from '../../scripts/check-privacy.mjs';

type Issue = { line: number; kind: string; match: string };

describe('公開前の個人情報の点検', () => {
  it('ユーザーのフォルダの絶対パス・メールアドレス・ユーザー名・秘密の値らしきものを見つける', () => {
    const text = ['a C:\\Users\\taro\\Desktop\\x', 'b /c/Users/taro/x', 'c mail taro.yamada@example.co.jp', 'd hello yamadataro', 'e key sk-ant-abcdefghijklmnopqrstuvwxyz012345'].join('\n'); // check-privacy: ignore(点検のテスト用の作り物)
    const issues = findIssues(text, ['yamadataro']) as Issue[];
    expect(issues.map((i) => i.line)).toEqual([1, 2, 3, 4, 5]);
  });
  it('置き換えた書き方・許したメールは見逃す', () => {
    const text = ['C:\\Users\\<ユーザー名>\\Documents', '%USERPROFILE%\\.codex', 'C:\\Users\\...', 'Co-Authored-By: Claude <noreply@anthropic.com>', 'npm i -g @openai/codex', 'user@example.com'].join('\n');
    expect(findIssues(text, [])).toEqual([]);
  });
  it('git で管理しているファイルに、個人情報らしき文字列が 0 件', () => {
    const r = scanRepo() as { files: number; found: Array<Issue & { file: string }> };
    expect(r.files).toBeGreaterThan(50);
    expect(r.found.map((f) => `${f.file}:${f.line} ${f.kind} ${f.match}`)).toEqual([]);
  });
});
