import { expect, test } from '@playwright/test';
import { createProject, launchApp } from './helpers';

test('全画面を開ける。数式が KaTeX で表示される', async () => {
  const t = await launchApp();
  const { page } = t;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await expect(page.getByTestId('screen-home')).toBeVisible();
  await page.getByTestId('new-project').click();
  await expect(page.getByTestId('screen-project-form')).toBeVisible();
  await createProject(page, { university: 'ダミー大学', faculty: '文学部', examDate: '2027-02-25', subjects: ['現代文', '世界史'] });

  // ダッシュボード → 科目(全タブ)
  await expect(page.getByTestId('screen-dashboard')).toBeVisible();
  await expect(page.getByTestId('days-left')).toHaveText('試験まであと 100 日');
  await page.getByTestId('subject-card').first().click();
  await expect(page.getByTestId('screen-subject')).toBeVisible();
  for (const tab of ['tests', 'sources', 'weakness', 'trend', 'notes', 'chats', 'units']) {
    await page.getByTestId(`tab-${tab}`).click();
    await expect(page.getByTestId(`tabpanel-${tab}`)).toBeVisible();
  }

  // 学習計画・取り込み
  await page.getByTestId('nav-plan').click();
  await expect(page.getByTestId('screen-plan')).toBeVisible();
  await page.getByTestId('nav-import').click();
  await expect(page.getByTestId('screen-import')).toBeVisible();

  // ジョブ一覧・設定
  await page.getByTestId('nav-jobs').click();
  await expect(page.getByTestId('screen-jobs')).toBeVisible();
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('screen-settings')).toBeVisible();
  await expect(page.getByTestId('fake-notice')).toBeVisible();
  await expect(page.getByTestId('data-dir')).toContainText('data');

  // 数式: KaTeX の要素になり、フォントも読めている
  const preview = page.getByTestId('math-preview');
  await expect(preview.locator('.katex')).toHaveCount(2);
  await expect(preview.locator('.katex-display')).toHaveCount(1);
  await page.getByTestId('math-input').fill('$\\frac{1}{$');
  await expect(preview.locator('.math-error')).toHaveCount(1);
  await page.getByTestId('math-input').fill('$\\sqrt{2}$');
  await expect(preview.locator('.katex')).toHaveCount(1);
  const fontOk = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].some((f) => f.family.includes('KaTeX') && f.status === 'loaded');
  });
  expect(fontOk).toBe(true);

  // 戻る → ダッシュボードへ
  await page.getByTestId('nav-dashboard').click();
  await expect(page.getByTestId('screen-dashboard')).toBeVisible();
  expect(errors).toEqual([]);
  await t.app.close();
});

test('ジョブの状態(実行中・待ち・完了・失敗、経過時間)がどの画面からも見え、取り消せる', async () => {
  const t = await launchApp();
  const { page } = t;
  // 偽 Claude が実際に呼ばれる順: 1回目・2回目は遅い、3回目は失敗、4回目以降は成功
  t.setFake({ kinds: { ping: ['slow', 'slow', 'fail'] }, slowMs: 60000 });

  await page.getByTestId('nav-settings').click();
  await page.getByTestId('s-concurrency').fill('1');
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();

  // 1つ目は実行中、同時実行数 1 なので 2つ目・3つ目は待ち
  await page.getByTestId('ping').click();
  await expect(page.getByTestId('jobbar-running')).toHaveText('実行中 1');
  await page.evaluate(() => {
    void window.me.call('startPing', []);
    void window.me.call('startPing', []);
  });
  await expect(page.getByTestId('jobbar-queued')).toHaveText('待ち 2');

  // 別の画面に移っても見える。経過時間が進む
  await page.getByTestId('nav-home').click();
  await expect(page.getByTestId('screen-home')).toBeVisible();
  await expect(page.getByTestId('jobbar-running')).toHaveText('実行中 1');
  await expect(page.getByTestId('jobbar')).toContainText('Claude との接続の確認');
  await expect(page.getByTestId('jobbar')).toContainText(/[1-9]秒/);

  // 帯をクリック → ジョブ一覧。待ちを1つ取り消し、実行中も取り消す
  await page.getByTestId('jobbar').click();
  await expect(page.getByTestId('screen-jobs')).toBeVisible();
  await expect(page.locator('[data-testid="jobrow"][data-status="running"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="jobrow"][data-status="queued"]')).toHaveCount(2);
  await page.locator('[data-testid="jobrow"][data-status="queued"]').first().getByTestId('job-cancel').click();
  await expect(page.locator('[data-testid="jobrow"][data-status="canceled"]')).toHaveCount(1);
  await page.locator('[data-testid="jobrow"][data-status="running"]').getByTestId('job-cancel').click();
  await expect(page.locator('[data-testid="jobrow"][data-status="canceled"]')).toHaveCount(2);

  // 残りの1つが動き出す → 取り消す。次に並べたものは失敗
  await expect(page.locator('[data-testid="jobrow"][data-status="running"]')).toHaveCount(1);
  await page.locator('[data-testid="jobrow"][data-status="running"]').getByTestId('job-cancel').click();
  await expect(page.locator('[data-testid="jobrow"][data-status="canceled"]')).toHaveCount(3);
  await page.evaluate(() => void window.me.call('startPing', []));
  await expect(page.getByTestId('jobbar-failed')).toHaveText('失敗 1');
  await expect(page.getByTestId('job-failure')).toContainText('Claude の呼び出しに失敗しました');

  // もう一度試す → 今度は成功
  await page.getByTestId('job-retry').click();
  await expect(page.getByTestId('jobbar-done')).toHaveText('完了 1');

  // 一覧から消す
  await page.getByTestId('clear-jobs').click();
  await expect(page.getByTestId('jobrow')).toHaveCount(0);
  await t.app.close();
});
