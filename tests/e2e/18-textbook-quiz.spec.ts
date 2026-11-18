import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerHtml, makeImage } from './fixtures';
import { createProject, launchApp } from './helpers';

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const row = (page: Page, unitId: string) => page.locator(`[data-testid="tb-row"][data-unit-id="${unitId}"]`);

test('確認問題: アプリで解く → 提出 → 採点 → 苦手マップ → 目次に「何問中何問」。紙で解いても同じ流れ。今日の課題と計画に「教材の第N章を読む」', async () => {
  const t = await launchApp();
  const { page } = t;
  await createProject(page, { university: 'ダミー大学', faculty: '理学部', examDate: '2027-02-25', subjects: ['数学II・B・C'] });
  const subjectDir = join(t.dataDir, 'ダミー大学 理学部', 'subjects', '数学II・B・C');

  // ── 今日の課題に「教材の第1章を読む」(まだ何も無いので目次の順)──
  await expect(page.getByTestId('today-reading-label')).toHaveText(/^教材の第1章「.+」を読む$/);
  await expect(page.getByTestId('today-reading')).toContainText('目次の順');

  // ── 章を2つ作る ──
  await page.getByTestId('subject-card').click();
  await page.getByTestId('tab-textbook').click();
  const rows = page.getByTestId('tb-row');
  const u1 = (await rows.nth(0).getAttribute('data-unit-id'))!;
  const u2 = (await rows.nth(1).getAttribute('data-unit-id'))!;
  await row(page, u1).getByTestId('tb-create').click();
  await row(page, u2).getByTestId('tb-create').click();
  await expect(row(page, u2).getByTestId('tb-status')).toHaveText('完成', { timeout: 20000 });
  await expect(row(page, u1).getByTestId('tb-status')).toHaveText('完成', { timeout: 20000 });

  // ── 第1章の確認問題をアプリで解く(1問目だけ正解)──
  await row(page, u1).getByTestId('tb-open').click();
  await expect(page.getByTestId('chapter-quiz-result')).toHaveText('確認問題: 3 問(まだ解いていません)');
  const quizId = json(join(subjectDir, 'textbook', 'toc.json')).chapters[0].quizTestId as string;
  const quiz = json(join(subjectDir, 'tests', quizId, 'test.json'));
  expect(quiz).toMatchObject({ kind: 'practice', chapterUnitId: u1 });
  await page.getByTestId('quiz-take').click();
  await page.getByTestId('take-start').click();
  const first = quiz.problems[0];
  const m = first.body.match(/\$(\d+) \+ (\d+)\$/)!;
  const answer = page.locator(`[data-testid="take-problem"][data-problem-id="${first.id}"]`);
  if (first.format === 'choice') await answer.getByTestId('choice-2').click();
  else await answer.getByTestId(first.format === 'short' ? 'take-short' : 'take-essay').fill(String(Number(m[1]) + Number(m[2])));
  await page.getByTestId('take-submit').click();
  await page.getByTestId('take-submit-yes').click();
  await expect(page.getByTestId('result-status')).toHaveText('採点済み');
  await expect(page.getByTestId('result-marks')).toHaveText('○××');

  // ── 目次に結果、苦手マップに記録 ──
  await page.getByTestId('result-back').click();
  await page.getByTestId('tab-textbook').click();
  await expect(row(page, u1).getByTestId('tb-quiz')).toContainText('確認問題: 3 問中 1 問');
  await expect(row(page, u1)).toContainText('習熟度');
  await page.getByTestId('tab-weakness').click();
  await expect(page.getByTestId('weakness-row')).toHaveCount(1);

  // ── 第2章の確認問題は、紙で解いて出す(読み取り → 確定 → 採点)──
  await page.getByTestId('tab-textbook').click();
  await row(page, u2).getByTestId('tb-open').click();
  const sheet = await makeImage(t.app, answerHtml(['問1 ②', '問2 25', '問3 位ごとに足して 26']), join(t.dataDir, '..', 'fixtures', 'quiz-answer.png'));
  await page.getByTestId('quiz-paper').click();
  await page.getByTestId('import-file').setInputFiles([sheet]);
  await page.getByTestId('import-run').click();
  await page.getByTestId('import-open').click();
  await page.getByTestId('read-start').click();
  await expect(page.getByTestId('pcard')).toHaveCount(3);
  await page.getByTestId('confirm-source').click();
  await expect(page.getByTestId('source-confirmed')).toBeVisible();
  await page.getByTestId('go-grade').click();
  await expect(page.getByTestId('result-status')).toHaveText('採点済み');
  await page.getByTestId('result-back').click();
  await page.getByTestId('tab-textbook').click();
  await expect(row(page, u2).getByTestId('tb-quiz')).toContainText(/確認問題: 3 問中 \d 問/);
  await page.getByTestId('tab-weakness').click();
  await expect(page.getByTestId('weakness-row')).toHaveCount(2);

  // ── 学習計画に「教材の第N章を読む」が入り、今日の課題にも出る ──
  await page.getByTestId('nav-plan').click();
  await page.getByTestId('create-plan').click();
  await expect(page.getByTestId('week-reading').first()).toContainText(/教材の第\d+章「.+」を読む/, { timeout: 15000 });
  const planned = (await page.getByTestId('week-reading').first().textContent())!;
  await page.getByTestId('nav-dashboard').click();
  await expect(page.getByTestId('today-reading')).toContainText('今週の計画');
  expect(planned).toContain((await page.getByTestId('today-reading-label').textContent())!);
  await page.getByTestId('today-reading-open').click();
  await expect(page.getByTestId('screen-chapter')).toBeVisible();
  await t.app.close();
});
