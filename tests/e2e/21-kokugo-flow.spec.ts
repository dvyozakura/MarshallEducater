import { expect, test } from '@playwright/test';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KOKUGO_HTML, makePdf } from './fixtures';
import { createProject, launchApp, repoRoot } from './helpers';

const shotsDir = join(repoRoot, 'Logs', 'shots');

test('国語: 問題作成(縦書きの記法)→ 解く画面に縦書きで表示。縦書きの PDF の読み取り → 補正(記法のボタン・縦書きのプレビュー)→ 確定', async () => {
  mkdirSync(shotsDir, { recursive: true });
  const t = await launchApp();
  const { page } = t;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 1回目の問題づくりは記法を壊して返す → やり直しで正しい記法になる
  t.setFake({ options: { designCount: 3 }, kinds: { generate_problems: ['bad_notation', 'ok'] } });
  await createProject(page, { university: 'ダミー大学', faculty: '文学部', examDate: '2027-02-25', subjects: ['現代文'] });

  // ── 問題作成 → 表示 ──
  await page.getByTestId('diag-create-all').click();
  await expect(page.locator('[data-testid="open-tests"] [data-testid="test-row"]')).toHaveCount(1);
  const calls = readFileSync(`${t.controlFile}.calls.jsonl`, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const gens = calls.filter((c) => c.kind === 'generate_problems');
  expect(gens.length).toBe(2);
  expect(gens[0].prompt).toContain('ME_TATEGAKI: write');
  expect(gens[1].prompt).toContain('縦書きの記法の書き方に誤りがあります');

  await page.locator('[data-testid="subject-card"][data-subject="現代文"]').click();
  await page.getByTestId('take-test').first().click();
  await page.getByTestId('take-start').click();
  const body = page.getByTestId('take-body').first();
  await expect(body).toHaveAttribute('data-writing', 'vertical');
  expect(await body.evaluate((el) => getComputedStyle(el).writingMode)).toBe('vertical-rl');
  await expect(body.locator('ruby')).toHaveCount(1);
  await expect(body.locator('.nt-line-solid')).toHaveCount(1);
  await expect(body.locator('.nt-blank')).toHaveCount(1);
  expect(await body.innerText()).not.toContain('{{');
  // 選択肢も縦書き
  const choice = page.getByTestId('take-choices').first();
  await expect(choice).toHaveClass(/tate-choices/);
  await page.getByTestId('take-problem').first().screenshot({ path: join(shotsDir, 's3-4-take-kokugo.png') });

  // ── 縦書きの PDF の読み取り → 補正 → 確定 ──
  const pdf = await makePdf(t.app, KOKUGO_HTML, join(t.dataDir, '..', 'fixtures', 'kokugo.pdf'));
  await page.getByTestId('nav-import').click();
  await page.getByTestId('import-file').setInputFiles([pdf]);
  await page.getByTestId('import-title').fill('ダミーの国語');
  await page.getByTestId('import-run').click();
  await page.getByTestId('import-open').click();
  await expect(page.getByTestId('screen-correction')).toBeVisible();
  await page.getByTestId('read-start').click();
  await expect(page.getByTestId('pcard')).toHaveCount(2);
  const reads = readFileSync(`${t.controlFile}.calls.jsonl`, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((c) => c.kind === 'read_pages');
  expect(reads.at(-1).prompt).toContain('ME_TATEGAKI: read');

  await page.getByTestId('pcard-head').first().click();
  const preview = page.getByTestId('c-preview-tate');
  await expect(preview).toHaveAttribute('data-writing', 'vertical');
  await expect(preview.locator('ruby')).toHaveCount(1);
  await expect(preview.locator('.nt-line-solid')).toHaveCount(1);
  await expect(page.getByTestId('notation-buttons')).toBeVisible();

  // 記法のボタン: 本文の「朝」を選んでルビ → 読みを入れる。傍線も足す
  const area = page.getByTestId('c-body');
  await area.evaluate((el: HTMLTextAreaElement) => {
    const at = el.value.indexOf('朝');
    el.focus();
    el.setSelectionRange(at, at + 1);
  });
  await page.getByTestId('ins-ruby').click();
  await expect.poll(() => area.inputValue()).toContain('{朝|よみ}');
  await page.keyboard.type('あさ');
  await expect.poll(() => area.inputValue()).toContain('{朝|あさ}');
  await expect(preview.locator('ruby')).toHaveCount(2);
  // 壊れた記法は注意が出る(プレビューは元の文字のまま)
  await area.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await page.getByTestId('ins-bousen').click();
  await expect.poll(() => area.inputValue()).toContain('{{傍線:ア|本文}}');
  await expect(page.getByTestId('c-notation-error')).toHaveCount(0);
  await area.fill(`${await area.inputValue()}{{傍線:イ|閉じていない`);
  await expect(page.getByTestId('c-notation-error')).toHaveCount(1);
  await expect(preview).toContainText('{{傍線:イ|閉じていない');
  await area.fill((await area.inputValue()).replace('{{傍線:イ|閉じていない', ''));
  await page.getByTestId('c-save').click();
  await page.locator('[data-testid="pcard"]').first().screenshot({ path: join(shotsDir, 's3-4-correction-kokugo.png') });
  await page.screenshot({ path: join(shotsDir, 's3-4-correction-kokugo-full.png') });

  // 漢文の問題: 訓読文のプレビュー
  await page.getByTestId('pcard-head').nth(1).click();
  await expect(page.getByTestId('c-preview-tate').locator('.kanbun-kundoku')).toHaveCount(1);

  await page.getByTestId('confirm-source').click();
  await expect(page.getByTestId('corr-status')).toContainText('確定');
  const sourcesDir = join(t.dataDir, 'ダミー大学 文学部', 'subjects', '現代文', 'sources');
  const ex = JSON.parse(readFileSync(join(sourcesDir, readdirSync(sourcesDir)[0], 'extracted.json'), 'utf8'));
  expect(ex.problems[0].body).toContain('{朝|あさ}');
  expect(ex.confirmedAt).toBeTruthy();
  expect(errors).toEqual([]);
  await t.app.close();
});
