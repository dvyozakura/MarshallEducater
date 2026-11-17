import { expect, test, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerHtml, ENGLISH_HTML, inspectPng, KOKUGO_HTML, makeImage, makePdf, MATH_HTML } from './fixtures';
import { createProject, launchApp } from './helpers';

async function importFiles(page: Page, opts: { files: string[]; kind: string; subject: string; title: string }) {
  await page.getByTestId('nav-import').click();
  await expect(page.getByTestId('screen-import')).toBeVisible();
  await page.getByTestId('import-file').setInputFiles(opts.files);
  await page.getByTestId('import-kind').selectOption(opts.kind);
  await page.getByTestId('import-subject').selectOption({ label: opts.subject });
  await page.getByTestId('import-title').fill(opts.title);
  await page.getByTestId('import-run').click();
}

function sourceDirs(dataDir: string, subject: string): string[] {
  const dir = join(dataDir, 'ダミー大学 総合', 'subjects', subject, 'sources');
  return existsSync(dir) ? readdirSync(dir).map((n) => join(dir, n)) : [];
}

test('自作のダミー PDF(数式・図、縦書きの国語、英文の長文)と画像を取り込める', async () => {
  const t = await launchApp();
  const { page, app } = t;
  const fx = join(t.dataDir, '..', 'fixtures');
  const mathPdf = await makePdf(app, MATH_HTML, join(fx, 'math.pdf'));
  const kokugoPdf = await makePdf(app, KOKUGO_HTML, join(fx, 'kokugo.pdf'));
  const englishPdf = await makePdf(app, ENGLISH_HTML, join(fx, 'english.pdf'));
  const answer1 = await makeImage(app, answerHtml(['第1問 x = 2, 3', '第2問 a_n = 2^n - 1']), join(fx, 'answer-1.png'));
  const answer2 = await makeImage(app, answerHtml(['第3問 ア 4 イ 5']), join(fx, 'answer-2.jpg'));

  await createProject(page, { university: 'ダミー大学', faculty: '総合', examDate: '2027-02-25', subjects: ['数学II・B・C', '現代文', '英語リーディング'] });

  // 数学(数式+図)1ページ
  await importFiles(page, { files: [mathPdf], kind: 'past_exam', subject: '数学II・B・C', title: 'ダミー模試 数学' });
  await expect(page.getByTestId('import-summary')).toContainText('1 ページ');
  await expect(page.getByTestId('import-summary')).toContainText('過去問');
  await expect(page.getByTestId('import-thumb')).toHaveCount(1);
  const [mathDir] = sourceDirs(t.dataDir, '数学II・B・C');
  expect(existsSync(join(mathDir, 'original.pdf'))).toBe(true);
  expect(readFileSync(join(mathDir, 'original.pdf')).subarray(0, 4).toString()).toBe('%PDF');
  const meta = JSON.parse(readFileSync(join(mathDir, 'source.json'), 'utf8'));
  expect(meta).toMatchObject({ version: 1, kind: 'past_exam', title: 'ダミー模試 数学', pageCount: 1, status: 'imported', fileName: 'math.pdf' });
  const mathPng = await inspectPng(app, join(mathDir, 'pages', 'page-001.png'));
  expect(Math.max(mathPng.width, mathPng.height)).toBe(1800);
  expect(mathPng.darkRatio).toBeGreaterThan(0.002); // 白紙ではない(文字と図が描かれている)
  // 文字の層も保存される(読み取りの助け)
  expect(readFileSync(join(mathDir, 'pages', 'page-001.txt'), 'utf8')).toContain('第1問');

  // 国語(縦書き)1ページ
  await importFiles(page, { files: [kokugoPdf], kind: 'workbook', subject: '現代文', title: 'ダミー 国語 縦書き' });
  await expect(page.getByTestId('import-summary')).toContainText('1 ページ');
  const [kokugoDir] = sourceDirs(t.dataDir, '現代文');
  const kokugoPng = await inspectPng(app, join(kokugoDir, 'pages', 'page-001.png'));
  expect(kokugoPng.darkRatio).toBeGreaterThan(0.002);
  expect(kokugoPng.height).toBeGreaterThan(kokugoPng.width);

  // 英語の長文(3ページ)
  await importFiles(page, { files: [englishPdf], kind: 'past_exam', subject: '英語リーディング', title: 'Dummy Reading' });
  await expect(page.getByTestId('import-summary')).toContainText('3 ページ');
  await expect(page.getByTestId('import-thumb')).toHaveCount(3);
  const [englishDir] = sourceDirs(t.dataDir, '英語リーディング');
  expect(readdirSync(join(englishDir, 'pages')).filter((n) => n.endsWith('.png'))).toEqual(['page-001.png', 'page-002.png', 'page-003.png']);
  for (const n of ['001', '002', '003']) {
    expect((await inspectPng(app, join(englishDir, 'pages', `page-${n}.png`))).darkRatio).toBeGreaterThan(0.002);
  }

  // 画像(PNG と JPG)2枚 → 2ページの資料になる
  await importFiles(page, { files: [answer2, answer1], kind: 'mock_result', subject: '数学II・B・C', title: '模試の結果(画像)' });
  await expect(page.getByTestId('import-summary')).toContainText('2 ページ');
  const imageDir = sourceDirs(t.dataDir, '数学II・B・C').find((d) => d !== mathDir)!;
  expect(readdirSync(imageDir).filter((n) => n.startsWith('original')).sort()).toEqual(['original-1.png', 'original-2.jpg']);
  expect((await inspectPng(app, join(imageDir, 'pages', 'page-002.png'))).darkRatio).toBeGreaterThan(0.0005);

  // 科目の資料一覧に出る。消せる
  await page.getByTestId('import-to-sources').click();
  await expect(page.getByTestId('source-row')).toHaveCount(2);
  await expect(page.getByTestId('source-row').first()).toContainText('模試の結果(画像)');
  await expect(page.getByTestId('source-status').first()).toContainText('未読み取り');
  await page.getByTestId('delete-source').first().click();
  await page.getByTestId('delete-source-yes').click();
  await expect(page.getByTestId('source-row')).toHaveCount(1);
  expect(existsSync(imageDir)).toBe(false);
  await t.app.close();
});

test('PDF でないファイル・壊れた PDF は、分かる言葉で断る(途中の資料は残さない)', async () => {
  const t = await launchApp();
  const { page } = t;
  await createProject(page, { university: 'ダミー大学', faculty: '総合', examDate: '2027-02-25', subjects: ['数学II・B・C'] });
  const fx = join(t.dataDir, '..', 'fixtures');
  await makePdf(t.app, '<p>x</p>', join(fx, 'ok.pdf'));
  writeFileSync(join(fx, 'broken.pdf'), 'これは PDF ではありません');
  writeFileSync(join(fx, 'memo.txt'), 'メモ');

  await page.getByTestId('nav-import').click();
  await page.getByTestId('import-file').setInputFiles([join(fx, 'memo.txt')]);
  await expect(page.getByTestId('import-run')).toBeDisabled();
  await expect(page.getByTestId('import-problems')).toContainText('PDF か画像');

  await page.getByTestId('import-file').setInputFiles([join(fx, 'broken.pdf')]);
  await page.getByTestId('import-run').click();
  await expect(page.getByTestId('import-error')).toContainText('PDF を開けませんでした');
  expect(sourceDirs(t.dataDir, '数学II・B・C')).toHaveLength(0);
  await t.app.close();
});
