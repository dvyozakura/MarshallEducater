import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, launchApp } from './helpers';

test('学習計画: 作成 → 週ごとの計画と模擬試験の予定 → 日がたって遅れたら作り直し', async () => {
  let t = await launchApp(); // 今日 = 2026-11-17
  let { page } = t;
  await createProject(page, { university: 'ダミー大学', faculty: '理学部', examDate: '2027-02-25', subjects: ['数学II・B・C', '英語リーディング'] });
  await page.getByTestId('nav-plan').click();
  await expect(page.getByTestId('plan-days-left')).toContainText('試験まであと 100 日');
  await page.getByTestId('create-plan').click();

  // 週ごとの計画(はじめは、これからの6週だけ)
  await expect(page.getByTestId('plan-week')).toHaveCount(6);
  await expect(page.getByTestId('plan-week').first()).toHaveAttribute('data-current', 'true');
  await expect(page.getByTestId('plan-week').first()).toContainText('第1週 11/17〜11/23');
  await expect(page.getByTestId('plan-week').first().getByTestId('week-item')).toHaveCount(2);
  await expect(page.getByTestId('plan-week').first()).toContainText('英語リーディング');
  await expect(page.getByTestId('plan-week').first()).toContainText('分');
  await expect(page.getByTestId('plan-advice')).toContainText('最初の計画');
  await expect(page.getByTestId('plan-meta')).toContainText('15 週ぶん');
  await expect(page.getByTestId('plan-late')).toHaveCount(0);
  await page.getByTestId('plan-show-all').click();
  await expect(page.getByTestId('plan-week')).toHaveCount(15);
  await expect(page.getByTestId('plan-week').last()).toContainText('総復習');
  // 通しの模擬試験の予定(2科目 × 2回)
  await expect(page.getByTestId('plan-mock')).toHaveCount(4);
  const planFile = join(t.dataDir, 'ダミー大学 理学部', 'plan.json');
  expect(JSON.parse(readFileSync(planFile, 'utf8'))).toMatchObject({ version: 1, startDate: '2026-11-17', examDate: '2027-02-25', revision: 0 });
  await t.app.close();

  // 5日後。課題を1日もやっていない → 作り直しを提案
  t = await launchApp({ dir: join(t.dataDir, '..'), env: { ME_TODAY: '2026-11-22' } });
  page = t.page;
  await page.getByTestId('project-card').click();
  await page.getByTestId('nav-plan').click();
  await expect(page.getByTestId('plan-late')).toContainText('5 日のうち 5 日');
  await page.getByTestId('plan-replan').click();
  await expect(page.getByTestId('plan-meta')).toContainText('作り直し 1 回目');
  await expect(page.getByTestId('plan-advice')).toContainText('作り直しました');
  await expect(page.getByTestId('plan-late')).toHaveCount(0);
  await expect(page.getByTestId('plan-week').first()).toContainText('第1週 11/22〜11/28');
  expect(JSON.parse(readFileSync(planFile, 'utf8'))).toMatchObject({ startDate: '2026-11-22', revision: 1 });
  await t.app.close();

  // 試験日を過ぎたら、作らずに案内する
  t = await launchApp({ dir: join(t.dataDir, '..'), env: { ME_TODAY: '2027-03-01' } });
  page = t.page;
  await page.getByTestId('project-card').click();
  await page.getByTestId('nav-plan').click();
  await expect(page.getByTestId('plan-exam-over')).toContainText('試験日を過ぎています');
  await expect(page.getByTestId('create-plan')).toHaveCount(0);
  await t.app.close();
});
