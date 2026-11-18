import { expect, test, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, launchApp } from './helpers';

const item = (page: Page, id: string) => page.locator(`[data-testid="result-item"][data-problem-id="${id}"]`);
const take = (page: Page, id: string) => page.locator(`[data-testid="take-problem"][data-problem-id="${id}"]`);

test('解説・質問・授業ノート: 採点後に解説が出る → 問題について2往復質問 → 再起動後も残る → ノートを作って質問', async () => {
  let t = await launchApp();
  let { page } = t;
  // 4問: 選択式(13+7)、短答(16+7)、記述(19+7)、短答(22+7)
  await createProject(page, { university: 'ダミー大学', faculty: '理学部', examDate: '2027-02-25', subjects: ['数学II・B・C'] });
  const subjectDir = join(t.dataDir, 'ダミー大学 理学部', 'subjects', '数学II・B・C');
  await page.getByTestId('diag-create').click();
  await page.locator('[data-testid="open-tests"]').getByTestId('take-test').click();
  await page.getByTestId('take-start').click();
  await take(page, 'p01').getByTestId('choice-2').click(); // 正解
  await take(page, 'p02').getByTestId('take-short').fill('99'); // 誤答
  await page.getByTestId('take-submit').click();
  await page.getByTestId('take-submit-yes').click();

  // ── 採点のあと、間違えた問題ごとの解説が出る ──
  await expect(page.getByTestId('result-status')).toHaveText('採点済み');
  await expect(page.getByTestId('explain-ready')).toContainText('間違えた 3 問の解説');
  await expect(item(page, 'p01').getByTestId('item-explanation')).toHaveCount(0);
  const ex = item(page, 'p02').getByTestId('item-explanation');
  await expect(ex).toContainText('考え方');
  await expect(ex).toContainText('解き方');
  await expect(ex).toContainText('同じミスを防ぐ一言');
  await expect(ex.locator('.katex').first()).toBeVisible();
  await expect(item(page, 'p04').getByTestId('item-tip')).toContainText('最初の一歩');
  const testDir = join(subjectDir, 'tests', readdirSync(join(subjectDir, 'tests'))[0]);
  expect(readFileSync(join(testDir, 'explanations.md'), 'utf8')).toContain('### 同じミスを防ぐ一言');
  // 解説を PDF に
  await page.getByTestId('export-explanations').click();
  await expect(page.getByTestId('export-path')).toContainText('explanations.pdf');
  expect(statSync(join(testDir, 'explanations.pdf')).size).toBeGreaterThan(2000);

  // ── 問題について質問する(2往復) ──
  await item(page, 'p02').getByTestId('ask-open').click();
  await expect(page.getByTestId('screen-chat')).toBeVisible();
  await expect(page.getByTestId('chat-context')).toContainText('問2');
  await expect(page.getByTestId('chat-problem')).toContainText('計算せよ');
  await expect(page.getByTestId('chat-send')).toBeDisabled();
  await page.getByTestId('chat-input').fill('なぜ $99$ では駄目なのですか?');
  await expect(page.getByTestId('chat-preview').locator('.katex')).toHaveCount(1);
  await page.getByTestId('chat-send').click();
  const msgs = page.getByTestId('chat-msg');
  await expect(msgs).toHaveCount(2);
  await expect(msgs.nth(0)).toContainText('なぜ $99$ では駄目なのですか?');
  await expect(msgs.nth(1)).toContainText('あなたの答案: 99');
  await expect(msgs.nth(1)).toContainText('採点: 0 / 10');
  await expect(msgs.nth(1)).toContainText('解説を踏まえています');
  await expect(msgs.nth(1).locator('.katex').first()).toBeVisible();
  await expect(page.getByTestId('chat-input')).toHaveValue('');
  await page.getByTestId('chat-input').fill('もう少しやさしくお願いします');
  await page.getByTestId('chat-input').press('Control+Enter');
  await expect(msgs).toHaveCount(4);
  await expect(msgs.nth(3)).toContainText('これまでのやりとり: 2 件');

  // ── 再起動後も残る。続きの質問もできる ──
  t = await t.relaunch();
  page = t.page;
  await page.getByTestId('project-card').click();
  await page.getByTestId('subject-card').click();
  await page.getByTestId('tab-chats').click();
  await expect(page.getByTestId('chat-row')).toHaveCount(1);
  await expect(page.getByTestId('chat-row')).toContainText('なぜ $99$ では駄目なのですか?');
  await expect(page.getByTestId('chat-row')).toContainText('2 往復');
  await page.getByTestId('chat-row').click();
  await expect(page.getByTestId('chat-msg')).toHaveCount(4);
  await expect(page.getByTestId('chat-context')).toContainText('問2');

  // ── 答えに失敗したら理由が出て、もう一度試せる ──
  t.setFake({ kinds: { chat: ['usage_limit'] } });
  await page.getByTestId('chat-input').fill('3つ目の質問');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('job-failure')).toHaveAttribute('data-failure', 'usage_limit');
  await expect(page.getByTestId('chat-msg')).toHaveCount(5); // 質問は残っている
  await page.getByTestId('job-retry').click();
  await expect(page.getByTestId('chat-msg')).toHaveCount(6);
  await expect(page.getByTestId('chat-msg').nth(5)).toContainText('これまでのやりとり: 4 件');

  // ── 授業ノートを作る → ノートについて質問 ──
  await page.getByTestId('chat-list').click();
  await page.getByTestId('tab-notes').click();
  const firstRow = page.getByTestId('note-row').first();
  await expect(firstRow).toContainText('習熟度'); // 弱い単元が上
  const unitId = (await firstRow.getAttribute('data-unit-id'))!;
  await firstRow.getByTestId('note-create').click();
  await expect(page.getByTestId('note-body')).toContainText('要点');
  await expect(page.getByTestId('note-body')).toContainText('よくある誤り');
  await expect(page.getByTestId('note-body').locator('.katex').first()).toBeVisible();
  await expect(page.locator(`[data-testid="note-row"][data-unit-id="${unitId}"]`)).toHaveAttribute('data-has-note', 'true');
  expect(existsSync(join(subjectDir, 'notes', `${unitId}.md`))).toBe(true);
  await page.getByTestId('note-ask').click();
  await expect(page.getByTestId('chat-context')).toContainText('授業ノート');
  await page.getByTestId('chat-input').fill('例題の考え方が分かりません');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-msg')).toHaveCount(2);
  await expect(page.getByTestId('chat-msg').nth(1)).toContainText('を踏まえています');
  expect(readdirSync(join(subjectDir, 'chats')).filter((f) => f.endsWith('.json'))).toHaveLength(2);
  await t.app.close();
});
