import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePdf, MATH_HTML } from './fixtures';
import { createProject, launchApp } from './helpers';

test('志望校の傾向: 過去問を確定すると作られ、科目の画面に出る。再診断を提案する', async () => {
  const t = await launchApp();
  const { page } = t;
  const pdf = await makePdf(t.app, MATH_HTML, join(t.dataDir, '..', 'fixtures', 'math.pdf'));
  await createProject(page, { university: 'ダミー大学', faculty: '理学部', examDate: '2027-02-25', subjects: ['数学II・B・C'] });

  // 先に診断テストを作っておく(過去問はまだ無い)
  await page.getByTestId('diag-create').click();
  await expect(page.locator('[data-testid="open-tests"] [data-testid="test-row"]')).toHaveCount(1);
  await page.getByTestId('subject-card').click();
  await page.getByTestId('tab-trend').click();
  await expect(page.getByTestId('trend-tab')).toContainText('過去問を取り込んで「確定」すると');
  await expect(page.getByTestId('update-trend')).toBeDisabled();

  // 過去問を取り込み → 読み取り → 確定(傾向の分析が自動で始まる)
  await page.getByTestId('trend-import').click();
  await page.getByTestId('import-file').setInputFiles([pdf]);
  await page.getByTestId('import-title').fill('2025年度 前期');
  await page.getByTestId('import-run').click();
  await page.getByTestId('import-open').click();
  await page.getByTestId('read-start').click();
  await expect(page.getByTestId('pcard')).toHaveCount(2);
  await page.getByTestId('confirm-source').click();
  await page.getByTestId('go-trend').click();

  // 科目の「傾向」に表示される
  await expect(page.getByTestId('trend-body')).toBeVisible();
  await expect(page.getByTestId('trend-sources')).toContainText('確定した過去問 1 件(2025年度 前期)');
  await expect(page.getByTestId('trend-format')).toContainText('が中心');
  await expect(page.getByTestId('trend-structure')).toContainText('第1問');
  await expect(page.getByTestId('trend-summary')).toContainText('過去問 1 件');
  await expect(page.getByTestId('trend-summary').locator('.katex')).toHaveCount(1);
  await expect(page.getByTestId('trend-stale')).toHaveCount(0);
  const subjectDir = join(t.dataDir, 'ダミー大学 理学部', 'subjects', '数学II・B・C');
  expect(existsSync(join(subjectDir, 'trend.json'))).toBe(true);
  expect(readFileSync(join(subjectDir, 'trend.md'), 'utf8')).toContain('の出題傾向');

  // 傾向を踏まえた再診断の提案 → 作ると提案は消える
  await expect(page.getByTestId('rediag-suggest')).toBeVisible();
  await page.getByTestId('rediag-create').click();
  await expect(page.getByTestId('rediag-suggest')).toHaveCount(0);
  await page.getByTestId('tab-tests').click();
  await expect(page.getByTestId('test-row')).toHaveCount(2);
  await expect(page.getByTestId('test-row').first()).toContainText('2回目');
  await t.app.close();
});
