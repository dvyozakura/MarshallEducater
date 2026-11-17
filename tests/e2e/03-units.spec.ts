import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, launchApp } from './helpers';

test('単元ツリー: 手で編集して保存 → Claude に調整させる', async () => {
  const t = await launchApp();
  const { page } = t;
  await createProject(page, { university: 'ダミー大学', faculty: '理学部', examDate: '2027-02-25', subjects: ['数学II・B・C'] });
  await page.getByTestId('subject-card').click();
  await expect(page.getByTestId('subject-name')).toHaveText('数学II・B・C');
  await page.getByTestId('tab-units').click();
  await expect(page.getByTestId('unit-row').first()).toBeVisible();
  const before = await page.getByTestId('unit-row').count();
  expect(before).toBeGreaterThan(30);

  // 手で編集: 名前を変え、重みを変え、単元を足す
  await page.getByTestId('unit-name').first().fill('式と証明(編集)');
  await page.getByTestId('unit-weight').first().selectOption('2');
  await page.getByTestId('add-top-unit').click();
  await expect(page.getByTestId('adjust-units')).toBeDisabled();
  await page.getByTestId('save-units').click();
  await expect(page.getByTestId('units-saved')).toBeVisible();
  const file = join(t.dataDir, 'ダミー大学 理学部', 'subjects', '数学II・B・C', 'units.json');
  let units = JSON.parse(readFileSync(file, 'utf8'));
  expect(units.tree[0]).toMatchObject({ name: '式と証明(編集)', weight: 2 });
  expect(units.tree.at(-1).name).toBe('新しい単元');

  // Claude(偽)に調整させる
  await page.getByTestId('adjust-units').click();
  await expect(page.getByTestId('units-note')).toContainText('最重点');
  await expect(page.getByTestId('unit-weight').first()).toHaveValue('3');
  units = JSON.parse(readFileSync(file, 'utf8'));
  expect(units.adjustedAt).toBeTruthy();
  expect(units.tree[0].children.at(-1).name).toBe('融合問題(目標校向け)');
  await expect(page.getByTestId('jobbar-done')).toContainText('1');
  await t.app.close();
});
