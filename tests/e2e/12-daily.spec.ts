import { expect, test, type Page } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, launchApp } from './helpers';

const take = (page: Page, id: string) => page.locator(`[data-testid="take-problem"][data-problem-id="${id}"]`);
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

interface TestFile {
  id: string;
  kind: string;
  date: string | null;
  status: string;
  problems: Array<{ id: string; format: 'choice' | 'short' | 'essay'; body: string; origin: string; reviewOf: { testId: string; problemId: string } | null }>;
}

test('今日の課題: 作る → 解く → 提出 → 採点 → 苦手マップ更新。2日後には復習が入る', async () => {
  let t = await launchApp(); // 今日 = 2026-11-17
  let { page } = t;
  await createProject(page, { university: 'ダミー大学', faculty: '理学部', examDate: '2027-02-25', subjects: ['数学II・B・C'] });
  const testsDir = join(t.dataDir, 'ダミー大学 理学部', 'subjects', '数学II・B・C', 'tests');
  const tests = (): TestFile[] => readdirSync(testsDir).map((d) => json(join(testsDir, d, 'test.json')) as TestFile);

  // ── 1日目: 今日の課題を作る ──
  const today = page.getByTestId('today');
  await expect(today).toContainText('今日の課題(11月17日)');
  await expect(today.getByTestId('today-item')).toHaveCount(1);
  await expect(today.getByTestId('today-item')).toContainText('数学II・B・C');
  await expect(today.getByTestId('today-no-plan')).toBeVisible();
  await today.getByTestId('today-create').click();
  const row = today.getByTestId('test-row');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-kind', 'daily');
  await expect(row).toContainText('11月17日の課題');
  await expect(today.getByTestId('today-mix')).toContainText('演習 8'); // まだ苦手マップが無い
  await expect(today.getByTestId('today-create')).toHaveCount(0); // 1日に1つ

  // ── 解く → 提出 → 採点 ──
  const daily = tests().find((x) => x.kind === 'daily')!;
  expect(daily).toMatchObject({ date: '2026-11-17', status: 'ready' });
  await row.getByTestId('take-test').click();
  await page.getByTestId('take-start').click();
  await expect(page.getByTestId('take-problem')).toHaveCount(daily.problems.length);
  // 1問目だけ正解する(偽の問題は「a + b」)。残りは未解答
  const first = daily.problems[0];
  const m = first.body.match(/\$(\d+) \+ (\d+)\$/)!;
  const sum = String(Number(m[1]) + Number(m[2]));
  if (first.format === 'choice') await take(page, first.id).getByTestId('choice-2').click();
  else await take(page, first.id).getByTestId(first.format === 'short' ? 'take-short' : 'take-essay').fill(sum);
  await page.getByTestId('take-submit').click();
  await page.getByTestId('take-submit-yes').click();
  await expect(page.getByTestId('screen-result')).toBeVisible();
  await expect(page.getByTestId('result-status')).toHaveText('採点済み');
  await expect(page.getByTestId('result-marks')).toHaveText('○×××××××');

  // ── ダッシュボード: 今日の課題は採点済み、最近の結果に出る ──
  await page.getByTestId('nav-dashboard').click();
  await expect(today.getByTestId('test-row')).toHaveAttribute('data-status', 'graded');
  await expect(page.getByTestId('recent-row')).toHaveCount(1);
  await expect(page.getByTestId('recent-row')).toContainText('11月17日の課題');
  // 復習の予定(間違えた7問が2日後)と、苦手マップ
  const review = json(join(testsDir, '..', 'review.json'));
  expect(review.items).toHaveLength(7);
  expect(review.items.every((i: { due: string; testId: string }) => i.due === '2026-11-19' && i.testId === daily.id)).toBe(true);
  await page.getByTestId('recent-row').click();
  await expect(page.getByTestId('screen-result')).toBeVisible();
  await page.getByTestId('result-back').click();
  await page.getByTestId('tab-weakness').click();
  await expect(page.getByTestId('weakness-row').first()).toBeVisible();
  await t.app.close();

  // ── 翌日: 新しい日の課題になる。復習はまだ ──
  t = await launchApp({ dir: join(t.dataDir, '..'), env: { ME_TODAY: '2026-11-18' } });
  page = t.page;
  await page.getByTestId('project-card').click();
  await expect(page.getByTestId('today')).toContainText('今日の課題(11月18日)');
  await expect(page.getByTestId('today').getByTestId('test-row')).toHaveCount(0);
  await expect(page.getByTestId('today').getByTestId('today-item')).not.toContainText('復習の期限');
  await t.app.close();

  // ── 2日後(1日やらなかった): 期限の来た復習と、苦手克服問題が入る ──
  t = await launchApp({ dir: join(t.dataDir, '..'), env: { ME_TODAY: '2026-11-19' } });
  page = t.page;
  await page.getByTestId('project-card').click();
  const today2 = page.getByTestId('today');
  await expect(today2.getByTestId('today-item')).toContainText('復習の期限が来た問題 7');
  await today2.getByTestId('today-create-one').click();
  await expect(today2.getByTestId('test-row')).toHaveCount(1);
  await expect(today2.getByTestId('test-row')).toContainText('11月19日の課題');
  await expect(today2.getByTestId('today-mix')).toContainText('復習 2');
  await expect(today2.getByTestId('today-mix')).toContainText(/苦手克服問題 \d/);
  const day3 = tests().find((x) => x.date === '2026-11-19')!;
  const rev = day3.problems.filter((p) => p.origin === 'review');
  expect(rev).toHaveLength(2);
  expect(rev[0].reviewOf).toMatchObject({ testId: daily.id });
  expect(rev[0].body).toContain('復習');
  await t.app.close();
});
