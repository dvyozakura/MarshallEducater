import { expect, test } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pdfInfo } from './fixtures';
import { createProject, launchApp } from './helpers';

test('プロジェクト作成後に診断テストの作成を案内 → 作成 → 問題冊子・解答用紙の PDF が出る', async () => {
  const t = await launchApp();
  const { page } = t;
  t.setFake({ options: { designCount: 6 }, kinds: { generate_problems: 'with_figure:1' } });
  await createProject(page, { university: 'ダミー大学', faculty: '理学部', examDate: '2027-02-25', subjects: ['数学II・B・C', '英語リーディング'] });

  // 案内が出る。まだの科目すべてで作る
  await expect(page.getByTestId('diag-guide')).toContainText('数学II・B・C、英語リーディング');
  await expect(page.getByTestId('diag-create')).toHaveCount(2);
  await page.getByTestId('diag-create-all').click();
  await expect(page.locator('[data-testid="open-tests"] [data-testid="test-row"]')).toHaveCount(2);
  await expect(page.getByTestId('diag-guide')).toHaveCount(0);
  await expect(page.getByTestId('subject-diag').first()).toContainText('未提出');

  // 科目の「テストと課題」に出る
  await page.locator('[data-testid="subject-card"][data-subject="数学II・B・C"]').click();
  const row = page.getByTestId('test-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('数学II・B・C 実力診断テスト');
  await expect(row).toContainText('6 問');
  await expect(row).toContainText('40 分');
  const testsDir = join(t.dataDir, 'ダミー大学 理学部', 'subjects', '数学II・B・C', 'tests');
  const testDir = join(testsDir, readdirSync(testsDir)[0]);
  for (const f of ['test.json', 'answer_key.json', 'verify.json']) expect(existsSync(join(testDir, f)), f).toBe(true);

  // 問題冊子の PDF: ページがあり、問題文の文字が入っている(答えは入っていない)
  await page.getByTestId('export-booklet').click();
  await expect(page.getByTestId('export-path')).toContainText('booklet.pdf');
  const booklet = await pdfInfo(join(testDir, 'booklet.pdf'));
  expect(booklet.pages).toBeGreaterThanOrEqual(1);
  const text = booklet.text.replace(/\s/g, '');
  expect(text).toContain('実力診断テスト');
  expect(text).toContain('制限時間:40分');
  expect(text).toContain('問1');
  expect(text).toContain('問6');
  expect(text).toContain('計算せよ');
  expect(text).not.toContain('足すと'); // 解説は入らない

  // 解答用紙の PDF
  await page.getByTestId('export-sheet').click();
  await expect(page.getByTestId('export-path')).toContainText('answer_sheet.pdf');
  const sheet = await pdfInfo(join(testDir, 'answer_sheet.pdf'));
  expect(sheet.pages).toBeGreaterThanOrEqual(1);
  expect(sheet.text.replace(/\s/g, '')).toContain('解答用紙');
  expect(sheet.text.replace(/\s/g, '')).toContain('問6');
  await t.app.close();
});
