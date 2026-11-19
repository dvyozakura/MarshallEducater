import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, launchApp, repoRoot } from './helpers';

export const shotsDir = join(repoRoot, 'Logs', 'shots');

test('組み方向: 国語は既定で縦書き、科目の設定で変えられる。縦書きの表示部品(縦中横・スクロール・文字の大きさ)', async () => {
  mkdirSync(shotsDir, { recursive: true });
  let t = await launchApp();
  let { page } = t;
  await t.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 800));
  await createProject(page, { university: 'ダミー大学', faculty: '文学部', examDate: '2027-02-25', subjects: ['現代文', '数学I・A'] });

  // 国語の科目は縦書き、数学は横書き
  await page.getByTestId('subject-card').filter({ hasText: '数学I・A' }).click();
  await expect(page.getByTestId('subject-writing')).toHaveText('横書き');
  await page.getByTestId('nav-home').click();
  await page.getByTestId('project-card').first().click();
  await page.getByTestId('subject-card').filter({ hasText: '現代文' }).click();
  await expect(page.getByTestId('subject-writing')).toHaveText('縦書き');

  await page.getByTestId('subject-settings-toggle').click();
  await expect(page.getByTestId('writing-mode')).toHaveValue('vertical');
  const sample = page.getByTestId('writing-sample');
  await expect(sample).toHaveAttribute('data-writing', 'vertical');
  expect(await sample.evaluate((el) => getComputedStyle(el).writingMode)).toBe('vertical-rl');
  // 2桁までの数字は縦中横、4桁はそのまま
  await expect(sample.locator('.tcy').filter({ hasText: /^12$/ })).toHaveCount(1);
  expect(await sample.locator('.tcy').first().evaluate((el) => getComputedStyle(el).textCombineUpright)).toBe('all');
  await expect(sample).toContainText('2026年');
  await expect(sample.locator('ruby')).toHaveCount(1);
  await sample.screenshot({ path: join(shotsDir, 's3-2-sample-18px.png') });

  // 文字を大きくすると、横にはみ出して横方向に読み進める
  for (let i = 0; i < 3; i++) await page.getByTestId('tate-fs-up').click();
  await expect(page.getByTestId('tate-fs-value')).toHaveText('28px');
  await page.waitForTimeout(100);
  const size = await sample.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, sl: el.scrollLeft }));
  expect(size.sw).toBeGreaterThan(size.cw);
  expect(size.sl).toBe(0); // 先頭は右端
  await sample.screenshot({ path: join(shotsDir, 's3-2-sample-28px-start.png') });
  // ホイールを下へ → 左へ進む
  await sample.hover();
  await page.mouse.wheel(0, 200);
  await expect.poll(() => sample.evaluate((el) => el.scrollLeft)).toBeLessThan(0);
  // Home で先頭、End で末尾
  await sample.focus();
  await page.keyboard.press('Home');
  await expect.poll(() => sample.evaluate((el) => el.scrollLeft)).toBe(0);
  await page.keyboard.press('End');
  await expect.poll(() => sample.evaluate((el) => Math.round(el.scrollLeft + el.scrollWidth - el.clientWidth))).toBeLessThanOrEqual(1);
  await sample.screenshot({ path: join(shotsDir, 's3-2-sample-28px-end.png') });
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => sample.evaluate((el) => Math.round(el.scrollLeft + el.scrollWidth - el.clientWidth))).toBeGreaterThan(1);
  for (let i = 0; i < 3; i++) await page.getByTestId('tate-fs-down').click();
  await page.screenshot({ path: join(shotsDir, 's3-2-subject-kokugo.png') });

  // 横書きに変える → 保存される
  await page.getByTestId('writing-mode').selectOption('horizontal');
  await expect(page.getByTestId('subject-writing')).toHaveText('横書き');
  await expect(page.getByTestId('writing-sample')).not.toHaveAttribute('data-writing', 'vertical');
  const projectFile = join(t.dataDir, 'ダミー大学 文学部', 'project.json');
  let pj = JSON.parse(readFileSync(projectFile, 'utf8'));
  expect(pj.subjects.find((s: { name: string }) => s.name === '現代文').writingMode).toBe('horizontal');

  // 既存のプロジェクト(組み方向の無い古い形式)も、読み込み時に国語は縦書きになる
  pj = { ...pj, subjects: pj.subjects.map((s: { id: string; name: string }) => ({ id: s.id, name: s.name })) };
  writeFileSync(projectFile, JSON.stringify(pj, null, 2), 'utf8');
  t = await t.relaunch();
  page = t.page;
  await page.getByTestId('project-card').first().click();
  await page.getByTestId('subject-card').filter({ hasText: '現代文' }).click();
  await expect(page.getByTestId('subject-writing')).toHaveText('縦書き');
  await t.app.close();
});
