import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, launchApp } from './helpers';

test('プロジェクトを作成 → 一覧に出る → 編集が反映される', async () => {
  let t = await launchApp();
  const { page } = t;
  await expect(page.getByTestId('screen-home')).toBeVisible();
  await expect(page.getByTestId('project-card')).toHaveCount(0);

  await createProject(page, { university: 'ダミー大学', faculty: '工学部', examDate: '2027-02-25', subjects: ['数学II・B・C', '英語リーディング'] });
  await expect(page.getByTestId('screen-dashboard')).toBeVisible();
  await expect(page.getByTestId('project-name')).toHaveText('ダミー大学 工学部');
  await expect(page.getByTestId('subject-card')).toHaveCount(2);

  // フォルダと、その中の CLAUDE.md・.claude/settings.json
  const dir = join(t.dataDir, 'ダミー大学 工学部');
  expect(existsSync(join(dir, 'project.json'))).toBe(true);
  expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('2027-02-25');
  expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(true);

  // 一覧に出る
  await page.getByTestId('nav-home').click();
  await expect(page.getByTestId('project-card')).toHaveCount(1);
  await expect(page.getByTestId('project-card')).toContainText('ダミー大学 工学部');
  await expect(page.getByTestId('project-card')).toContainText('2027年2月25日');

  // 編集が反映される
  await page.getByTestId('project-card').click();
  await page.getByTestId('edit-project').click();
  await expect(page.getByTestId('f-examDate')).toHaveValue('2027-02-25');
  await page.getByTestId('f-examDate').fill('2027-03-12');
  await page.getByTestId('f-targetLevel').selectOption('top');
  await page.getByTestId('f-dailyMinutes').fill('240');
  await page.getByTestId('subject-化学').check();
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('screen-dashboard')).toBeVisible();
  await expect(page.getByTestId('project-summary')).toContainText('上位での合格をねらう');
  await expect(page.getByTestId('project-summary')).toContainText('240 分');
  await expect(page.getByTestId('subject-card')).toHaveCount(3);
  const md = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
  expect(md).toContain('2027-03-12');
  expect(md).toContain('化学');

  // 起動し直しても残っている
  t = await t.relaunch();
  await expect(t.page.getByTestId('project-card')).toHaveCount(1);
  await expect(t.page.getByTestId('project-card')).toContainText('2027年3月12日');
  await t.app.close();
});

test('入力が足りないと作成できない', async () => {
  const { app, page } = await launchApp();
  await page.getByTestId('new-project').click();
  await expect(page.getByTestId('save-project')).toBeDisabled();
  await expect(page.getByTestId('form-problems')).toContainText('試験日');
  await page.getByTestId('f-university').fill('ダミー大学');
  await page.getByTestId('f-examDate').fill('2027-02-25');
  await expect(page.getByTestId('form-problems')).toContainText('科目');
  await page.getByTestId('f-custom-subject').fill('小論文');
  await page.getByTestId('f-add-subject').click();
  await expect(page.getByTestId('save-project')).toBeEnabled();
  await app.close();
});
