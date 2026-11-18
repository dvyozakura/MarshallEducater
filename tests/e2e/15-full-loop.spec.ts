import { expect, test, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerHtml, makeImage } from './fixtures';
import { createProject, launchApp } from './helpers';

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const item = (page: Page, id: string) => page.locator(`[data-testid="result-item"][data-problem-id="${id}"]`);
const take = (page: Page, id: string) => page.locator(`[data-testid="take-problem"][data-problem-id="${id}"]`);

// CLAUDE.md「完成の基準」: 新規プロジェクト作成から、診断テスト → 答案提出 → 読み取り補正 → 採点 → 苦手マップ →
// 学習計画 → 今日の課題 → 解説 → 質問、までが偽 Claude の自動操作テストで一周通る。
test('一周: プロジェクト作成 → 診断テスト → 紙の答案 → 読み取り補正 → 採点 → 苦手マップ → 学習計画 → 今日の課題 → 解説 → 質問', async () => {
  const t = await launchApp();
  const { page } = t;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 診断テストは3問(選択式 13+7、短答 16+7、記述 19+7)。紙の答案の読み取り結果は3問とも正解の内容
  t.setFake({ options: { designCount: 3, scanAnswers: { 問1: '2', 問2: '$23$', 問3: '位ごとに足して 26' } } });

  // 1. プロジェクトを作る
  await createProject(page, { university: 'ダミー大学', faculty: '理学部', examDate: '2027-02-25', subjects: ['数学II・B・C'] });
  const subjectDir = join(t.dataDir, 'ダミー大学 理学部', 'subjects', '数学II・B・C');
  const tests = () => readdirSync(join(subjectDir, 'tests')).map((d) => ({ dir: join(subjectDir, 'tests', d), test: json(join(subjectDir, 'tests', d, 'test.json')) }));

  // 2. 実力診断テストを Claude が作る(検算つき)
  await page.getByTestId('diag-create').click();
  const open = page.locator('[data-testid="open-tests"] [data-testid="test-row"]');
  await expect(open).toHaveCount(1);
  const diag = tests()[0];
  expect(diag.test).toMatchObject({ kind: 'diagnostic', status: 'ready' });
  expect(json(join(diag.dir, 'verify.json')).counts).toEqual({ adopted: 3, regenerated: 0, discarded: 0 });

  // 3. 紙で解いた答案(画像)を出す → Claude が読み取る
  const sheet = await makeImage(t.app, answerHtml(['問1 ②', '問2 25', '問3 位ごとに足して 26']), join(t.dataDir, '..', 'fixtures', 'answer.png'));
  await open.getByTestId('submit-paper').click();
  await page.getByTestId('import-file').setInputFiles([sheet]);
  await page.getByTestId('import-run').click();
  await page.getByTestId('import-open').click();
  await page.getByTestId('read-start').click();
  await expect(page.getByTestId('pcard')).toHaveCount(3);

  // 4. 読み取り結果を補正して確定(問2 は、紙には 25 と書いてあるのに 23 と読まれている → 直す)
  await page.getByTestId('pcard-head').nth(1).click();
  await expect(page.getByTestId('c-body')).toHaveValue('$23$');
  await page.getByTestId('c-body').fill('$25$');
  await page.getByTestId('c-save').click();
  await page.getByTestId('confirm-source').click();
  await expect(page.getByTestId('source-confirmed')).toBeVisible();
  expect(json(join(diag.dir, 'reading.json'))).toMatchObject({ method: 'scan', confirmed: true });
  expect(json(join(diag.dir, 'submission', 'corrections.json')).changedChars).toBeGreaterThan(0);

  // 5. 採点(部分点・ミスの種類・所見)
  await page.getByTestId('go-grade').click();
  await expect(page.getByTestId('result-status')).toHaveText('採点済み');
  await expect(page.getByTestId('result-total')).toHaveText('30 / 40 点(75%)');
  await expect(page.getByTestId('result-marks')).toHaveText('○×○');
  await expect(item(page, 'p02').getByTestId('item-mistake')).toHaveText('計算・処理ミス');

  // 9(先に確認). 解説: 間違えた問題に、考え方 → 解き方 → 同じミスを防ぐ一言
  await expect(page.getByTestId('explain-ready')).toContainText('間違えた 1 問の解説');
  await expect(item(page, 'p02').getByTestId('item-explanation')).toContainText('考え方');
  await expect(item(page, 'p02').getByTestId('item-tip')).toContainText('確かめましょう');

  // 6. 苦手マップ(単元 × ミスの種類、習熟度)
  await page.getByTestId('result-back').click();
  await page.getByTestId('tab-weakness').click();
  await expect(page.getByTestId('weakness-row')).toHaveCount(3);
  await expect(page.getByTestId('weakness-overall')).toContainText('科目全体の習熟度');
  await expect(page.getByTestId('weakness-row').first().getByTestId('miss-calculation')).toHaveText('1'); // いちばん弱い単元 = 間違えた問2

  // 7. 学習計画(試験日から逆算した週ごとの計画)
  await page.getByTestId('nav-plan').click();
  await page.getByTestId('create-plan').click();
  await expect(page.getByTestId('plan-week')).toHaveCount(6);
  await expect(page.getByTestId('plan-week').first()).toHaveAttribute('data-current', 'true');
  expect(existsSync(join(t.dataDir, 'ダミー大学 理学部', 'plan.json'))).toBe(true);

  // 8. 今日の課題(苦手克服問題)→ 解く → 提出 → 採点 → 苦手マップ更新
  await page.getByTestId('nav-dashboard').click();
  const today = page.getByTestId('today');
  await expect(today.getByTestId('today-no-plan')).toHaveCount(0);
  await today.getByTestId('today-create').click();
  await expect(today.getByTestId('test-row')).toHaveCount(1);
  await expect(today.getByTestId('today-mix')).toContainText('苦手克服問題');
  const daily = tests().find((x) => x.test.kind === 'daily')!;
  await today.getByTestId('take-test').click();
  await page.getByTestId('take-start').click();
  const first = daily.test.problems[0] as { id: string; format: string; body: string };
  const m = first.body.match(/\$(\d+) \+ (\d+)\$/)!;
  if (first.format === 'choice') await take(page, first.id).getByTestId('choice-2').click();
  else await take(page, first.id).getByTestId(first.format === 'short' ? 'take-short' : 'take-essay').fill(String(Number(m[1]) + Number(m[2])));
  await page.getByTestId('take-submit').click();
  await page.getByTestId('take-submit-yes').click();
  await expect(page.getByTestId('result-status')).toHaveText('採点済み');
  await expect(item(page, first.id).getByTestId('item-score')).toContainText(/^(\d+) \/ \1 点$/); // 1問目は満点
  expect(json(join(subjectDir, 'weakness.json')).updatedAt).toBeTruthy();
  expect(json(join(subjectDir, 'review.json')).items.length).toBeGreaterThan(0); // 間違えた問題は、間をあけて復習に出る

  // 9. 解説(今日の課題の、間違えた問題)
  const wrong = (daily.test.problems as Array<{ id: string }>)[1].id;
  await expect(item(page, wrong).getByTestId('item-explanation')).toContainText('解き方');
  expect(readFileSync(join(daily.dir, 'explanations.md'), 'utf8')).toContain('### 考え方');

  // 10. 質問(その問題・答案・採点・苦手マップを文脈に渡す。続きの質問もできる)
  await item(page, wrong).getByTestId('ask-open').click();
  await page.getByTestId('chat-input').fill('どこから手を付ければよいですか?');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-msg')).toHaveCount(2);
  await expect(page.getByTestId('chat-msg').nth(1)).toContainText('あなたの答案: 未解答');
  await expect(page.getByTestId('chat-msg').nth(1)).toContainText('苦手マップ: 弱い単元');
  await page.getByTestId('chat-input').fill('式の立て方をもう一度お願いします');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-msg')).toHaveCount(4);
  await expect(page.getByTestId('chat-msg').nth(3)).toContainText('これまでのやりとり: 2 件');
  expect(readdirSync(join(subjectDir, 'chats')).filter((f) => f.endsWith('.json'))).toHaveLength(1);

  // ダッシュボードに、ここまでの結果がまとまっている
  await page.getByTestId('nav-dashboard').click();
  await expect(page.getByTestId('recent-row')).toHaveCount(2);
  await expect(page.getByTestId('jobbar-failed')).toHaveText('失敗 0');
  // すべての呼び出しが logs/ に残っている
  expect(readdirSync(join(t.dataDir, 'ダミー大学 理学部', 'logs')).length).toBeGreaterThanOrEqual(10);
  expect(errors).toEqual([]);
  await t.app.close();
});
