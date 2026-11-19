import { expect, test, type Page } from '@playwright/test';
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inspectPng, pdfInfo } from './fixtures';
import { createProject, launchApp, repoRoot } from './helpers';

const shotsDir = join(repoRoot, 'Logs', 'shots');

/** PDF をアプリに取り込み(pdf.js でページ画像にする)、ページ画像の場所を返す。 */
async function pagesOf(page: Page, dataDir: string, subjectDir: string, pdf: string, title: string): Promise<string[]> {
  await page.getByTestId('nav-import').click();
  await page.getByTestId('import-file').setInputFiles([pdf]);
  await page.getByTestId('import-title').fill(title);
  await page.getByTestId('import-run').click();
  await expect(page.getByTestId('import-open')).toBeVisible();
  const sourcesDir = join(subjectDir, 'sources');
  const dirs = readdirSync(sourcesDir).map((d) => join(sourcesDir, d));
  // いちばん新しく取り込んだ資料
  const dir = dirs.sort((a, b) => statSync(a).birthtimeMs - statSync(b).birthtimeMs).at(-1)!;
  void dataDir;
  return readdirSync(join(dir, 'pages'))
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => join(dir, 'pages', f));
}

test('国語の PDF: 問題冊子・解答用紙(マーク欄・マス目・罫線)・教材が縦書きで出る', async () => {
  mkdirSync(shotsDir, { recursive: true });
  const t = await launchApp();
  const { page } = t;
  t.setFake({ options: { designCount: 8 } });
  await createProject(page, { university: 'ダミー大学', faculty: '文学部', examDate: '2027-02-25', subjects: ['現代文'] });
  const subjectDir = join(t.dataDir, 'ダミー大学 文学部', 'subjects', '現代文');
  await page.getByTestId('diag-create').click();
  await page.locator('[data-testid="subject-card"][data-subject="現代文"]').click();
  await page.getByTestId('export-booklet').click();
  await expect(page.getByTestId('export-path')).toContainText('booklet.pdf');
  const testsDir = join(subjectDir, 'tests');
  const testDir = join(testsDir, readdirSync(testsDir)[0]);
  const booklet = await pdfInfo(join(testDir, 'booklet.pdf'));
  expect(booklet.pages).toBeGreaterThanOrEqual(2); // 8問なので複数ページにまたがる
  expect(booklet.text).toContain('実力診断テスト');
  await page.getByTestId('export-sheet').click();
  await expect(page.getByTestId('export-path')).toContainText('answer_sheet.pdf');
  const sheet = await pdfInfo(join(testDir, 'answer_sheet.pdf'));
  expect(sheet.pages).toBeGreaterThanOrEqual(1);
  expect(sheet.text.replace(/\s/g, '')).toContain('解答用紙');
  expect(sheet.text.replace(/\s/g, '')).toContain('40字'); // 字数指定のマス目

  // ページ画像にして、白紙でないこと・縦に組めていることを目で確かめる用に保存
  const bookletPages = await pagesOf(page, t.dataDir, subjectDir, join(testDir, 'booklet.pdf'), '冊子の確認');
  expect(bookletPages.length).toBe(booklet.pages);
  for (const [i, f] of bookletPages.entries()) {
    const info = await inspectPng(t.app, f);
    expect(info.darkRatio).toBeGreaterThan(0.005);
    copyFileSync(f, join(shotsDir, `s3-6-booklet-p${i + 1}.png`));
  }
  const sheetPages = await pagesOf(page, t.dataDir, subjectDir, join(testDir, 'answer_sheet.pdf'), '解答用紙の確認');
  for (const [i, f] of sheetPages.entries()) {
    copyFileSync(f, join(shotsDir, `s3-6-sheet-p${i + 1}.png`));
    expect((await inspectPng(t.app, f)).darkRatio).toBeGreaterThan(0.002);
  }

  // 教材の章の PDF
  await page.getByTestId('nav-home').click();
  await page.getByTestId('project-card').first().click();
  await page.locator('[data-testid="subject-card"][data-subject="現代文"]').click();
  await page.getByTestId('tab-textbook').click();
  const first = page.getByTestId('tb-row').first();
  await first.getByTestId('tb-create').click();
  await expect(first.getByTestId('tb-status')).toHaveText('完成', { timeout: 15000 });
  await first.getByTestId('tb-open').click();
  await page.getByTestId('chapter-export').click();
  await expect(page.getByTestId('chapter-export-path')).toContainText('.pdf');
  const pdfDir = join(subjectDir, 'textbook', 'pdf');
  const chapterPdf = join(pdfDir, readdirSync(pdfDir).find((f) => f.endsWith('.pdf'))!);
  const ch = await pdfInfo(chapterPdf);
  expect(ch.pages).toBeGreaterThanOrEqual(1);
  const chPages = await pagesOf(page, t.dataDir, subjectDir, chapterPdf, '教材の確認');
  copyFileSync(chPages[0], join(shotsDir, 's3-6-textbook-p1.png'));
  await t.app.close();
});
