import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, launchApp, repoRoot } from './helpers';

const shotsDir = join(repoRoot, 'Logs', 'shots');

test('国語: テストを作る → 縦書きで解く → 提出 → 採点結果(問題文は縦書き、所見・解説は横書き)', async () => {
  mkdirSync(shotsDir, { recursive: true });
  const t = await launchApp();
  const { page } = t;
  t.setFake({ options: { designCount: 3 } });
  await createProject(page, { university: 'ダミー大学', faculty: '文学部', examDate: '2027-02-25', subjects: ['古文'] });
  await page.getByTestId('diag-create').click();
  await page.locator('[data-testid="open-tests"]').getByTestId('take-test').click();
  await page.getByTestId('take-start').click();
  const probs = page.getByTestId('take-problem');
  await expect(probs).toHaveCount(3);
  // 本文と解答欄が並ぶ(解答欄は本文の左)
  const layout = await probs.first().evaluate((sec) => {
    const b = sec.querySelector('.take-tate-body')!.getBoundingClientRect();
    const a = sec.querySelector('.take-tate-answer')!.getBoundingClientRect();
    return { bodyLeft: b.left, answerRight: a.right, bodyTop: b.top, answerTop: a.top };
  });
  expect(layout.answerRight).toBeLessThanOrEqual(layout.bodyLeft + 1);
  expect(Math.abs(layout.bodyTop - layout.answerTop)).toBeLessThan(5);
  await probs.nth(0).getByTestId('choice-2').click(); // 正解
  await probs.nth(1).getByTestId('take-short').fill('99'); // 誤答
  await expect(probs.nth(1).getByTestId('take-short')).toHaveCSS('writing-mode', 'horizontal-tb'); // 入力欄は横書き
  await page.screenshot({ path: join(shotsDir, 's3-5-take-kobun.png') });
  await page.getByTestId('take-submit').click();
  await page.getByTestId('take-submit-yes').click();

  await expect(page.getByTestId('screen-result')).toBeVisible();
  await expect(page.getByTestId('result-status')).toHaveText('採点済み');
  const item = page.getByTestId('result-item').nth(1);
  await expect(item.getByTestId('item-body')).toHaveAttribute('data-writing', 'vertical');
  expect(await item.getByTestId('item-comment').evaluate((el) => getComputedStyle(el).writingMode)).toBe('horizontal-tb');
  expect(await item.getByTestId('item-rationale').evaluate((el) => getComputedStyle(el).writingMode)).toBe('horizontal-tb');
  await expect(item.getByTestId('item-tip')).toBeVisible({ timeout: 15000 });
  expect(await item.getByTestId('item-tip').evaluate((el) => getComputedStyle(el).writingMode)).toBe('horizontal-tb');
  await item.screenshot({ path: join(shotsDir, 's3-5-result-kobun.png') });
  await t.app.close();
});

test('国語: 教材の章は縦書き。縦書きの本文を選んで「ここを質問」できる', async () => {
  mkdirSync(shotsDir, { recursive: true });
  const t = await launchApp();
  const { page } = t;
  await createProject(page, { university: 'ダミー大学', faculty: '文学部', examDate: '2027-02-25', subjects: ['現代文'] });
  await page.getByTestId('subject-card').click();
  await page.getByTestId('tab-textbook').click();
  const first = page.getByTestId('tb-row').first();
  await first.getByTestId('tb-create').click();
  await expect(first.getByTestId('tb-status')).toHaveText('完成', { timeout: 15000 });
  await first.getByTestId('tb-open').click();
  const points = page.getByTestId('chapter-points');
  const tate = points.locator('[data-writing="vertical"]').first();
  await expect(tate).toBeVisible();
  expect(await tate.evaluate((el) => getComputedStyle(el).writingMode)).toBe('vertical-rl');
  await expect(points.locator('.kanbun-kundoku')).toHaveCount(1);
  // 質問欄は横書き
  expect(await page.getByTestId('tchat-panel').evaluate((el) => getComputedStyle(el).writingMode)).toBe('horizontal-tb');

  // 縦書きの本文の文字列を選ぶ → 「ここを質問」
  await page.evaluate((text) => {
    const root = document.querySelector('[data-testid="chapter-points"]')!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const i = node.textContent!.indexOf(text);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + text.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      node.parentElement!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return;
    }
    throw new Error('not found');
  }, '筆者は、同じことを');
  await expect(page.getByTestId('ask-here')).toBeVisible();
  await page.getByTestId('ask-here').click();
  await expect(page.getByTestId('tchat-quote')).toContainText('筆者は、同じことを');
  await page.getByTestId('tchat-input').fill('言いかえとは何ですか?');
  await page.getByTestId('tchat-send').click();
  await expect(page.getByTestId('tchat-msg')).toHaveCount(2, { timeout: 15000 });
  await expect(page.getByTestId('tchat-msg').nth(1)).toContainText('選んだ箇所「筆者は、同じことを」');
  await page.screenshot({ path: join(shotsDir, 's3-5-chapter-gendaibun.png') });
  await t.app.close();
});
