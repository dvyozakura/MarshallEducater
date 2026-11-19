import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { KOKUGO_HTML, makePdf } from './fixtures';
import { createProject, launchApp, repoRoot } from './helpers';

// README 用の画面の画像(偽 Claude・ダミーのデータだけ。個人情報は写らない)を Docs/images/ に作る。
// tests/tmp/readme-shots.flag があるときだけ動く(ふだんのテストでは画像を書き換えない)。
const enabled = existsSync(join(repoRoot, 'tests', 'tmp', 'readme-shots.flag'));

test('README の画面の画像を作る', async () => {
  test.skip(!enabled, 'tests/tmp/readme-shots.flag が無いので飛ばす');
  const out = join(repoRoot, 'Docs', 'images');
  mkdirSync(out, { recursive: true });
  const t = await launchApp();
  const { page } = t;
  await t.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  t.setFake({ options: { designCount: 4 } });
  await createProject(page, { university: 'サンプル大学', faculty: '文学部', examDate: '2027-02-25', subjects: ['現代文', '数学II・B・C'] });
  await page.getByTestId('diag-create-all').click();
  await expect(page.locator('[data-testid="open-tests"] [data-testid="test-row"]')).toHaveCount(2);
  await page.screenshot({ path: join(out, 'dashboard.png') });

  // 数学: 解いて採点結果(数式)
  await page.locator('[data-testid="subject-card"][data-subject="数学II・B・C"]').click();
  await page.getByTestId('take-test').first().click();
  await page.getByTestId('take-start').click();
  await page.getByTestId('take-problem').first().getByTestId('choice-2').click();
  await page.getByTestId('take-submit').click();
  await page.getByTestId('take-submit-yes').click();
  await expect(page.getByTestId('result-status')).toHaveText('採点済み');
  await page.getByTestId('result-item').nth(1).getByTestId('item-tip').waitFor({ timeout: 15000 });
  await page.screenshot({ path: join(out, 'result.png') });

  // 国語: 縦書きで解く
  await page.getByTestId('nav-dashboard').click();
  await page.locator('[data-testid="subject-card"][data-subject="現代文"]').click();
  await page.getByTestId('take-test').first().click();
  await page.getByTestId('take-start').click();
  await page.getByTestId('take-body').first().waitFor();
  await page.screenshot({ path: join(out, 'take-kokugo.png') });

  // 補正画面(縦書きの PDF の読み取り)
  const pdf = await makePdf(t.app, KOKUGO_HTML, join(t.dataDir, '..', 'fixtures', 'kokugo.pdf'));
  await page.getByTestId('nav-import').click();
  await page.getByTestId('import-file').setInputFiles([pdf]);
  await page.getByTestId('import-title').fill('サンプルの国語');
  await page.getByTestId('import-run').click();
  await page.getByTestId('import-open').click();
  await page.getByTestId('read-start').click();
  await page.getByTestId('pcard-head').first().click();
  await page.getByTestId('c-preview-tate').waitFor();
  await page.screenshot({ path: join(out, 'correction.png') });

  // 教材の章
  await page.getByTestId('nav-dashboard').click();
  await page.locator('[data-testid="subject-card"][data-subject="現代文"]').click();
  await page.getByTestId('tab-textbook').click();
  const first = page.getByTestId('tb-row').first();
  await first.getByTestId('tb-create').click();
  await expect(first.getByTestId('tb-status')).toHaveText('完成', { timeout: 15000 });
  await first.getByTestId('tb-open').click();
  await page.getByTestId('chapter-points').waitFor();
  await page.screenshot({ path: join(out, 'textbook.png') });
  await t.app.close();
});
