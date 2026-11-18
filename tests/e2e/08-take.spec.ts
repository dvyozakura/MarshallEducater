import { expect, test, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerHtml, makeImage } from './fixtures';
import { createProject, launchApp, type Launched } from './helpers';

function testDir(t: Launched, project: string, subject: string): string {
  const dir = join(t.dataDir, project, 'subjects', subject, 'tests');
  return join(dir, readdirSync(dir)[0]);
}
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const problem = (page: Page, id: string) => page.locator(`[data-testid="take-problem"][data-problem-id="${id}"]`);

test('テストを解いて答案を出す: アプリ内で入力(途中の控えが残る)/紙の答案を取り込んで読み取り・補正', async () => {
  const t = await launchApp();
  const { page } = t;
  t.setFake({ options: { designCount: 3, scanAnswers: { 問1: '2', 問2: '$23$', 問3: '位ごとに足して 26' } } });
  await createProject(page, { university: 'ダミー大学', faculty: '理学部', examDate: '2027-02-25', subjects: ['数学II・B・C', '物理'] });
  await page.getByTestId('diag-create-all').click();
  const rows = page.locator('[data-testid="open-tests"] [data-testid="test-row"]');
  await expect(rows).toHaveCount(2);

  // ── アプリ内で解く(数学) ──
  await rows.filter({ hasText: '数学' }).getByTestId('take-test').click();
  await expect(page.getByTestId('take-summary')).toContainText('3 問');
  await expect(page.getByTestId('take-summary')).toContainText('制限時間 40 分');
  await page.getByTestId('take-start').click();
  await expect(page.getByTestId('take-timer')).toContainText('残り');
  await expect(page.getByTestId('take-problem')).toHaveCount(3);
  await expect(page.getByTestId('take-body').first().locator('.katex')).toHaveCount(1);

  // 選択式・短答(LaTeX 入力とプレビュー)・記述
  await problem(page, 'p01').getByTestId('choice-2').click();
  await problem(page, 'p02').getByTestId('take-short').fill('$\\frac{46}{2}$');
  await expect(problem(page, 'p02').getByTestId('take-preview').locator('.katex')).toHaveCount(1);
  await expect(page.getByTestId('take-progress')).toHaveText('回答済み 2 / 3');

  // 途中で他の画面に移っても、入力と時間は残る
  const dir = testDir(t, 'ダミー大学 理学部', '数学II・B・C');
  await expect.poll(() => existsSync(join(dir, 'draft.json'))).toBe(true);
  await page.getByTestId('nav-dashboard').click();
  await rows.filter({ hasText: '数学' }).getByTestId('take-test').click();
  await expect(page.getByTestId('take-progress')).toHaveText('回答済み 2 / 3');
  await expect(problem(page, 'p02').getByTestId('take-short')).toHaveValue('$\\frac{46}{2}$');
  await expect(problem(page, 'p01').getByTestId('choice-2').locator('input')).toBeChecked();

  // 未回答があると確かめてから提出
  await page.getByTestId('take-submit').click();
  await expect(page.getByTestId('take-unanswered')).toContainText('未回答が 1 問');
  await page.getByTestId('take-submit-yes').click();
  await expect(page.getByTestId('screen-result')).toBeVisible();
  const reading = json(join(dir, 'reading.json'));
  expect(reading).toMatchObject({ method: 'inapp', confirmed: true });
  expect(reading.answers).toEqual([
    { problemId: 'p01', answer: '2' },
    { problemId: 'p02', answer: '$\\frac{46}{2}$' },
    { problemId: 'p03', answer: '' },
  ]);
  expect(typeof reading.elapsedSec).toBe('number');
  expect(['submitted', 'graded']).toContain(json(join(dir, 'test.json')).status); // 提出すると、そのまま採点が始まる
  expect(existsSync(join(dir, 'draft.json'))).toBe(false);

  // ── 紙の答案を出す(物理) ──
  const sheet = await makeImage(t.app, answerHtml(['問1 ②', '問2 23', '問3 位ごとに足して 26']), join(t.dataDir, '..', 'fixtures', 'answer.png'));
  await page.getByTestId('nav-dashboard').click();
  await expect(rows).toHaveCount(1); // 採点まで済んだ数学は「これから解くテスト」から外れる
  await rows.filter({ hasText: '物理' }).getByTestId('submit-paper').click();
  await expect(page.getByTestId('screen-import')).toBeVisible();
  await expect(page.getByTestId('import-kind')).toBeDisabled();
  await expect(page.getByTestId('import-kind')).toHaveValue('answer');
  await page.getByTestId('import-file').setInputFiles([sheet]);
  await page.getByTestId('import-run').click();
  await expect(page.getByTestId('import-summary')).toContainText('答案');
  const pdir = testDir(t, 'ダミー大学 理学部', '物理');
  expect(existsSync(join(pdir, 'submission', 'pages', 'page-001.png'))).toBe(true);
  expect(json(join(pdir, 'test.json')).status).toBe('reading');

  // 読み取り → 補正(答案の内容と、どの設問への解答かを直す)→ 確定
  await page.getByTestId('import-open').click();
  await page.getByTestId('read-start').click();
  await expect(page.getByTestId('pcard')).toHaveCount(3);
  await expect(page.getByTestId('pcard').first()).toContainText('→ 問1');
  await page.getByTestId('pcard-head').nth(1).click();
  await expect(page.getByTestId('c-body')).toHaveValue('$23$');
  await page.getByTestId('c-body').fill('$25$');
  await page.getByTestId('c-target').selectOption('問3');
  await page.getByTestId('c-save').click();
  await expect(page.getByTestId('pcard').nth(1)).toContainText('→ 問3');
  await page.getByTestId('c-target').selectOption('');
  await page.getByTestId('confirm-source').click();
  await expect(page.getByTestId('corr-error')).toContainText('どの設問への解答か'); // 対応が未定のままでは確定できない
  await page.getByTestId('c-target').selectOption('問2');
  await page.getByTestId('confirm-source').click();
  await expect(page.getByTestId('source-confirmed')).toBeVisible();
  const scan = json(join(pdir, 'reading.json'));
  expect(scan).toMatchObject({ method: 'scan', confirmed: true });
  expect(scan.answers).toEqual([
    { problemId: 'p01', answer: '2' },
    { problemId: 'p02', answer: '$25$' },
    { problemId: 'p03', answer: '位ごとに足して 26' },
  ]);
  expect(json(join(pdir, 'test.json')).status).toBe('submitted');
  await page.getByTestId('go-grade').click();
  await expect(page.getByTestId('screen-result')).toBeVisible();
  await expect(page.getByTestId('result-total')).toContainText('/ 40 点');
  await t.app.close();
});

test('制限時間: 時間になると入力が止まり、延ばして続けられる', async () => {
  const t = await launchApp({ env: { ME_TIMER_SPEED: '800' } }); // 40分が3秒で過ぎる
  const { page } = t;
  t.setFake({ options: { designCount: 3 } });
  await createProject(page, { university: 'ダミー大学', faculty: '理学部', examDate: '2027-02-25', subjects: ['数学II・B・C'] });
  await page.getByTestId('diag-create').click();
  await page.locator('[data-testid="open-tests"]').getByTestId('take-test').click();
  await page.getByTestId('take-start').click();
  await expect(page.getByTestId('take-timeup')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('take-short')).toBeDisabled();
  await page.getByTestId('take-extend').click();
  await expect(page.getByTestId('take-short')).toBeEnabled();
  await expect(page.getByTestId('take-timer')).toContainText('超過');
  await page.getByTestId('take-short').fill('20');
  await page.getByTestId('take-submit').click();
  await page.getByTestId('take-submit-yes').click();
  await expect(page.getByTestId('screen-result')).toBeVisible();
  const dir = testDir(t, 'ダミー大学 理学部', '数学II・B・C');
  expect(json(join(dir, 'reading.json')).elapsedSec).toBeGreaterThanOrEqual(2400);
  await t.app.close();
});
