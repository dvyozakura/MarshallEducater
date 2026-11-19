import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers';

// smoke_real --kokugo で本物の Claude が作った問題を、アプリの画面(縦書き)で表示してスクリーンショットを撮る。
// ME_SMOKE_DIR(smoke_real の作業フォルダ)か、tests/tmp/smoke-view-dir.txt(1行目にその場所)があるときだけ動く。Claude は呼ばない。
const viewFile = join(repoRoot, 'tests', 'tmp', 'smoke-view-dir.txt');
const smokeDir = process.env.ME_SMOKE_DIR || (existsSync(viewFile) ? readFileSync(viewFile, 'utf8').split('\n')[0].trim() : '');

test('smoke_real --kokugo の結果を縦書きで表示する', async () => {
  test.skip(!smokeDir, 'ME_SMOKE_DIR が無いので飛ばす');
  const shots = join(repoRoot, 'Logs', 'shots');
  mkdirSync(shots, { recursive: true });
  const t = await launchApp({ dir: smokeDir });
  const { page } = t;
  await page.getByTestId('project-card').first().click();
  for (const name of ['現代文', '漢文']) {
    await page.getByTestId('nav-dashboard').click();
    await page.locator(`[data-testid="subject-card"][data-subject="${name}"]`).click();
    await page.getByTestId('take-test').first().click();
    // 前に開いたことがあれば、途中の控えから始まる
    await page.getByTestId('take-start').or(page.getByTestId('take-body').first()).first().waitFor();
    if (await page.getByTestId('take-start').isVisible()) await page.getByTestId('take-start').click();
    const body = page.getByTestId('take-body').first();
    await expect(body).toHaveAttribute('data-writing', 'vertical');
    await page.getByTestId('take-problem').first().screenshot({ path: join(shots, `s3-6-real-${name}.png`) });
  }
  await t.app.close();
});
