import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, launchApp } from './helpers';

test('失敗時の案内: claude が無い・未ログイン・使用量上限・通信失敗・1日の上限を見分けて案内し、もう一度試せる', async () => {
  const t = await launchApp();
  const { page } = t;
  await page.getByTestId('nav-settings').click();
  const failure = page.getByTestId('job-failure');

  const cases: Array<[control: unknown, kind: string, title: string, guide: string]> = [
    [{ notFound: true }, 'not_found', 'Claude Code(claude)が見つかりません', '設定画面の「claude の場所」'],
    [{ default: 'not_logged_in' }, 'not_logged_in', 'Claude Code にログインしていません', '/login'],
    [{ default: 'usage_limit' }, 'usage_limit', 'Claude の使用量の上限に達しました', '上限が戻る時刻まで待ってから'],
    [{ default: 'network' }, 'network', 'Claude との通信に失敗しました', 'インターネットの接続を確かめて'],
  ];
  for (const [control, kind, title, guide] of cases) {
    t.setFake(control);
    await page.getByTestId('ping').click();
    await expect(failure).toHaveAttribute('data-failure', kind);
    await expect(failure).toContainText(title);
    await expect(failure).toContainText(guide);
    await expect(page.getByTestId('ping-ok')).toHaveCount(0);
    // 直ったら「もう一度試す」で通る
    t.setFake({});
    await page.getByTestId('job-retry').click();
    await expect(page.getByTestId('ping-ok')).toBeVisible();
    await expect(failure).toHaveCount(0);
  }
  // 使用量上限のときは、戻る時刻(Claude の出力)も見える
  t.setFake({ default: 'usage_limit' });
  await page.getByTestId('ping').click();
  await expect(failure).toContainText('resets 12:30am');
  t.setFake({});

  // 1日の上限(アプリ側): いまの回数を上限にすると、次は呼ばずに断る
  const used = Number((await page.getByTestId('usage').textContent())!.match(/今日は (\d+) 回/)![1]);
  await page.getByTestId('s-dailyLimit').fill(String(Math.max(1, used)));
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
  await page.getByTestId('ping').click();
  await expect(failure).toHaveAttribute('data-failure', 'daily_limit');
  await expect(failure).toContainText('今日の呼び出し回数の上限に達しました');
  await expect(failure).toContainText('設定画面の「1日の上限」を増やす');
  await page.getByTestId('s-dailyLimit').fill('200');
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
  await page.getByTestId('job-retry').click();
  await expect(page.getByTestId('ping-ok')).toBeVisible();

  // 失敗はジョブ一覧にも残り、そこからも案内が読める
  await page.getByTestId('nav-jobs').click();
  await expect(page.locator('[data-testid="jobrow"][data-status="failed"]').first().getByTestId('job-failure')).toBeVisible();
  await t.app.close();
});

test('設定: claude の場所・モデル・同時実行数・1日の上限が保存される。「品質」欄に検算と採点の数が出る', async () => {
  let t = await launchApp();
  let { page } = t;
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('q-verify')).toContainText('まだ問題を作っていません');
  await expect(page.getByTestId('q-problems')).toContainText('まだ補正の記録がありません');
  await expect(page.getByTestId('q-grading')).toContainText('まだ採点がありません');
  await page.getByTestId('s-claudePath').fill('C:\\tools\\claude.exe');
  await page.getByTestId('s-model').fill('opus');
  await page.getByTestId('s-concurrency').fill('3');
  await page.getByTestId('s-dailyLimit').fill('150');
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
  await expect(page.getByTestId('usage')).toContainText('上限 150 回');
  expect(JSON.parse(readFileSync(join(t.userData, 'settings.json'), 'utf8'))).toMatchObject({ claudePath: 'C:\\tools\\claude.exe', model: 'opus', concurrency: 3, dailyLimit: 150 });
  await expect(page.getByTestId('data-dir')).toContainText(t.dataDir);

  // 診断テスト(4問)を作る: 2問目は解き直しと合わず、作り直しで採用
  t.setFake({ kinds: { solve_problems: ['wrong:2', 'ok'] } });
  await createProject(page, { university: 'ダミー大学', faculty: '理学部', examDate: '2027-02-25', subjects: ['数学II・B・C'] });
  await page.getByTestId('diag-create').click();
  await page.locator('[data-testid="open-tests"]').getByTestId('take-test').click();
  await page.getByTestId('take-start').click();
  await page.getByTestId('take-submit').click();
  await page.getByTestId('take-submit-yes').click();
  await expect(page.getByTestId('result-status')).toHaveText('採点済み');
  const first = page.locator('[data-testid="result-item"]').first();
  await first.getByTestId('override-open').click();
  await first.getByTestId('override-score').fill('5');
  await first.getByTestId('override-save').click();
  await expect(first.getByTestId('override-badge')).toBeVisible();

  // 再起動しても設定は残り、「品質」欄に数が出る
  t = await t.relaunch();
  page = t.page;
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('s-model')).toHaveValue('opus');
  await expect(page.getByTestId('s-concurrency')).toHaveValue('3');
  await expect(page.getByTestId('q-verify')).toContainText('採用 3 ・ 作り直して採用 1 ・ 破棄 0');
  await expect(page.getByTestId('q-verify')).toContainText('テスト 1 件');
  await expect(page.getByTestId('q-grading')).toContainText('1 / 4 問(25%)');
  await t.app.close();
});
