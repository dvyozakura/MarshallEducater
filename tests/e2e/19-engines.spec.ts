import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { createProject, launchApp } from './helpers';

const take = (page: Page, id: string) => page.locator(`[data-testid="take-problem"][data-problem-id="${id}"]`);
const calls = (controlFile: string): string[] => {
  const f = `${controlFile}.calls.jsonl`;
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((c) => `${c.engine ?? 'claude'}:${c.kind}`);
};

test('教員エンジン: 接続確認(入っていない・未ログインの案内)→ 役割ごとの割り当て・別 AI での検算 → 成果物と品質欄にエンジンが出る → プロジェクトごとの上書き', async () => {
  let t = await launchApp();
  let { page } = t;
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('engine-status-claude')).toHaveText('未確認');
  await expect(page.getByTestId('engine-status-codex')).toHaveText('未確認');

  // 入っていない(Gemini)・未ログイン(ChatGPT)を見分けて案内する
  t.setFake({ notFoundEngines: ['gemini'], engineModes: { codex: 'not_logged_in' } });
  await page.getByTestId('engine-check-gemini').click();
  const geminiRow = page.getByTestId('engine-row-gemini');
  await expect(geminiRow.getByTestId('job-failure')).toHaveAttribute('data-failure', 'not_found');
  await expect(geminiRow.getByTestId('job-failure')).toHaveAttribute('data-engine', 'gemini');
  await expect(geminiRow.getByTestId('job-failure')).toContainText('Gemini(Gemini CLI)が入っていません');
  await expect(page.getByTestId('engine-status-gemini')).toHaveText('入っていません');
  await page.getByTestId('engine-check-codex').click();
  const codexRow = page.getByTestId('engine-row-codex');
  await expect(codexRow.getByTestId('job-failure')).toHaveAttribute('data-failure', 'not_logged_in');
  await expect(codexRow.getByTestId('job-failure')).toContainText('ChatGPT(Codex CLI)にログインしていません');
  await expect(codexRow.getByTestId('job-failure')).toContainText('codex login');
  await expect(page.getByTestId('engine-status-codex')).toHaveText('ログインしていません');

  // ログインしたら、つながる
  t.setFake({ notFoundEngines: ['gemini'] });
  await page.getByTestId('engine-check-codex').click();
  await expect(page.getByTestId('engine-status-codex')).toHaveText('つながっています');
  await expect(page.getByTestId('engine-row-codex')).toContainText('fake-codex');

  // 採点を ChatGPT に、検算は問題作成と別の AI に
  await page.getByTestId('s-role-grade').selectOption('codex');
  await page.getByTestId('s-verifyWithOther').check();
  await page.getByTestId('save-settings-engines').click();
  await expect(page.getByTestId('resolved-grade')).toHaveAttribute('data-engine', 'codex');
  await expect(page.getByTestId('resolved-verify')).toHaveAttribute('data-engine', 'codex');
  await expect(page.getByTestId('resolved-verify')).toContainText('別の AI');
  await expect(page.getByTestId('resolved-create')).toHaveAttribute('data-engine', 'claude');

  // 診断テストを作って解く → 採点
  await createProject(page, { university: 'ダミー大学', faculty: '理学部', examDate: '2027-02-25', subjects: ['数学II・B・C'] });
  await page.getByTestId('diag-create').click();
  await page.locator('[data-testid="open-tests"]').getByTestId('take-test').click();
  await expect(page.getByTestId('madeby-test')).toHaveAttribute('data-engine', 'claude');
  await page.getByTestId('take-start').click();
  await take(page, 'p01').getByTestId('choice-2').click();
  await take(page, 'p02').getByTestId('take-short').fill('23');
  await page.getByTestId('take-submit').click();
  await page.getByTestId('take-submit-yes').click();
  await expect(page.getByTestId('screen-result')).toBeVisible();
  await expect(page.getByTestId('madeby-grading')).toHaveAttribute('data-engine', 'codex');
  await expect(page.getByTestId('madeby-grading')).toContainText('ChatGPT');
  const log = calls(t.controlFile);
  expect(log).toContain('claude:generate_problems');
  expect(log).toContain('codex:solve_problems');
  expect(log).not.toContain('claude:solve_problems');
  expect(log).toContain('codex:grade');

  // 品質の欄: エンジン別
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('q-engine-claude')).toBeVisible();
  await expect(page.getByTestId('q-engine-codex')).toContainText('/ 4 問');

  // プロジェクトごとの上書き: 採点を Gemini に → 再起動しても残る → 元に戻す
  await page.getByTestId('nav-home').click();
  await page.getByTestId('project-card').click();
  await expect(page.getByTestId('project-engines-summary')).toContainText('アプリ全体の設定に従っています');
  await expect(page.getByTestId('project-engines-summary')).toContainText('採点: ChatGPT');
  await page.getByTestId('project-engines-toggle').click();
  await page.getByTestId('p-role-grade').selectOption('gemini');
  await page.getByTestId('project-engines-save').click();
  await expect(page.getByTestId('project-engines-saved')).toBeVisible();
  await expect(page.getByTestId('project-engines-summary')).toContainText('このプロジェクトだけの割り当てがあります');
  await expect(page.getByTestId('project-engines-summary')).toContainText('採点: Gemini');

  t = await t.relaunch();
  page = t.page;
  await page.getByTestId('project-card').click();
  await expect(page.getByTestId('project-engines-summary')).toContainText('採点: Gemini');
  await page.getByTestId('project-engines-toggle').click();
  await page.getByTestId('project-engines-reset').click();
  await expect(page.getByTestId('project-engines-summary')).toContainText('アプリ全体の設定に従っています');
  // アプリ全体の設定も残っている
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('s-role-grade')).toHaveValue('codex');
  await expect(page.getByTestId('s-verifyWithOther')).toBeChecked();
  await expect(page.getByTestId('engine-status-codex')).toHaveText('つながっています');
  await t.app.close();
});
