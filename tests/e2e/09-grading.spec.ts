import { expect, test, type Page } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, launchApp } from './helpers';

const item = (page: Page, id: string) => page.locator(`[data-testid="result-item"][data-problem-id="${id}"]`);
const take = (page: Page, id: string) => page.locator(`[data-testid="take-problem"][data-problem-id="${id}"]`);

test('採点: 提出 → Claude の採点(部分点・ミスの種類・所見)→ 上書き → 再起動後も残る', async () => {
  let t = await launchApp();
  let { page } = t;
  // 4問: 選択式(13+7)、短答(16+7)、記述(19+7)、短答(22+7)
  await createProject(page, { university: 'ダミー大学', faculty: '理学部', examDate: '2027-02-25', subjects: ['数学II・B・C'] });
  await page.getByTestId('diag-create').click();
  await page.locator('[data-testid="open-tests"]').getByTestId('take-test').click();
  await page.getByTestId('take-start').click();
  await take(page, 'p01').getByTestId('choice-2').click(); // 正解
  await take(page, 'p02').getByTestId('take-short').fill('99'); // 誤答
  await take(page, 'p03').getByTestId('take-essay').fill('位ごとに足すと $30$ くらい'); // 部分点
  await page.getByTestId('take-submit').click();
  await page.getByTestId('take-submit-yes').click();

  // 提出すると採点が始まり、結果が出る
  await expect(page.getByTestId('screen-result')).toBeVisible();
  await expect(page.getByTestId('result-total')).toHaveText('20 / 50 点(40%)');
  await expect(page.getByTestId('result-status')).toHaveText('採点済み');
  await expect(page.getByTestId('result-marks')).toHaveText('○×△×');
  await expect(item(page, 'p01').getByTestId('item-score')).toHaveText('10 / 10 点');
  await expect(item(page, 'p01').getByTestId('item-answer')).toContainText('②');
  await expect(item(page, 'p02').getByTestId('item-mistake')).toHaveText('計算・処理ミス');
  await expect(item(page, 'p02').getByTestId('item-comment')).toContainText('和の計算');
  await expect(item(page, 'p02').getByTestId('item-key').locator('.katex')).toHaveCount(1);
  await expect(item(page, 'p03').getByTestId('item-score')).toHaveText('10 / 20 点');
  await expect(item(page, 'p03').getByTestId('item-rationale')).toContainText('考え方の説明');
  await expect(item(page, 'p04').getByTestId('item-mistake')).toHaveText('未解答');
  await expect(item(page, 'p04').getByTestId('item-answer')).toContainText('未解答');

  // 上書き(採点が厳しすぎる、など)
  await item(page, 'p03').getByTestId('override-open').click();
  await item(page, 'p03').getByTestId('override-score').fill('16');
  await item(page, 'p03').getByTestId('override-note').fill('説明は十分に書けている');
  await item(page, 'p03').getByTestId('override-save').click();
  await expect(item(page, 'p03').getByTestId('item-score')).toHaveText('16 / 20 点');
  await expect(item(page, 'p03').getByTestId('override-badge')).toContainText('Claude の採点は 10 点');
  await expect(page.getByTestId('result-total')).toHaveText('26 / 50 点(52%)');

  // 再起動後も残る
  t = await t.relaunch();
  page = t.page;
  await page.getByTestId('project-card').click();
  await page.getByTestId('subject-card').click();
  await expect(page.getByTestId('test-status')).toHaveText('採点済み');
  await page.getByTestId('open-result').click();
  await expect(page.getByTestId('result-total')).toHaveText('26 / 50 点(52%)');
  await expect(item(page, 'p03').getByTestId('override-badge')).toContainText('説明は十分に書けている');

  // 上書きの取り消しも記録に残る
  await item(page, 'p03').getByTestId('override-clear').click();
  await expect(page.getByTestId('result-total')).toHaveText('20 / 50 点(40%)');
  const testsDir = join(t.dataDir, 'ダミー大学 理学部', 'subjects', '数学II・B・C', 'tests');
  const grading = JSON.parse(readFileSync(join(testsDir, readdirSync(testsDir)[0], 'grading.json'), 'utf8'));
  expect(grading.overrides.map((o: { from: number; to: number }) => `${o.from}->${o.to}`)).toEqual(['10->16', '16->10']);
  expect(grading.items[2].override).toBeNull();

  // 苦手マップ: 単元 × ミスの種類の表と、習熟度
  await page.getByTestId('result-back').click();
  await page.getByTestId('tab-weakness').click();
  await expect(page.getByTestId('weakness-row')).toHaveCount(4);
  await expect(page.getByTestId('weakness-overall')).toContainText('科目全体の習熟度');
  const masteries = (await page.getByTestId('weakness-mastery').allTextContents()).map(Number);
  expect([...masteries].sort((a, b) => a - b)).toEqual(masteries); // 弱い順
  expect(masteries[0]).toBeLessThan(50);
  expect(masteries[3]).toBeGreaterThan(50);
  await expect(page.locator('[data-testid="miss-calculation"].miss')).toHaveCount(2);
  await expect(page.locator('[data-testid="miss-blank"].miss')).toHaveCount(1);
  await page.getByTestId('nav-dashboard').click();
  await expect(page.getByTestId('subject-mastery')).toContainText('習熟度');
  await expect(page.getByTestId('subject-gap')).toContainText('目標(75)まで');
  await t.app.close();
});

test('採点に失敗したら理由が出て、もう一度試せる', async () => {
  const t = await launchApp();
  const { page } = t;
  t.setFake({ kinds: { grade: ['usage_limit'] } });
  await createProject(page, { university: 'ダミー大学', faculty: '理学部', examDate: '2027-02-25', subjects: ['数学II・B・C'] });
  await page.getByTestId('diag-create').click();
  await page.locator('[data-testid="open-tests"]').getByTestId('take-test').click();
  await page.getByTestId('take-start').click();
  await take(page, 'p01').getByTestId('choice-1').click();
  await page.getByTestId('take-submit').click();
  await page.getByTestId('take-submit-yes').click();
  await expect(page.getByTestId('job-failure')).toHaveAttribute('data-failure', 'usage_limit');
  await expect(page.getByTestId('result-status')).toContainText('提出済み');
  await page.getByTestId('job-retry').click();
  await expect(page.getByTestId('result-total')).toHaveText('0 / 50 点(0%)');
  await expect(item(page, 'p01').getByTestId('item-mistake')).toHaveText('読み違い');
  await t.app.close();
});
