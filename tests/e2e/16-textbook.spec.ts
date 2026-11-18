import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pdfInfo } from './fixtures';
import { createProject, launchApp } from './helpers';

const row = (page: Page, unitId: string) => page.locator(`[data-testid="tb-row"][data-unit-id="${unitId}"]`);

test('教材: タブを開く → 章を作る(進み具合が目次に出る)→ 読む → 既読 → 再起動後も残る → PDF が出る', async () => {
  let t = await launchApp();
  let { page } = t;
  await createProject(page, { university: 'ダミー大学', faculty: '理学部', examDate: '2027-02-25', subjects: ['数学II・B・C'] });
  const textbookDir = join(t.dataDir, 'ダミー大学 理学部', 'subjects', '数学II・B・C', 'textbook');

  // ── 「教材」タブ: 単元ツリーの順の目次。最初はすべて未作成 ──
  await page.getByTestId('subject-card').click();
  await page.getByTestId('tab-textbook').click();
  await expect(page.getByTestId('textbook-tab')).toBeVisible();
  const rows = page.getByTestId('tb-row');
  await expect(rows).toHaveCount(44);
  await expect(page.getByTestId('tb-summary')).toHaveText('完成 0 / 44 章・既読 0 章');
  await expect(rows.first()).toContainText('第1章');
  await expect(rows.first()).toContainText('整式の割り算と分数式');
  await expect(rows.first().getByTestId('tb-status')).toHaveText('未作成');
  await expect(rows.first()).toContainText('作ると: 標準');
  await expect(rows.first().getByTestId('tb-read')).toBeDisabled(); // 未作成の章は既読にできない
  await expect(page.getByTestId('tb-export-all')).toBeDisabled();
  const u1 = (await rows.nth(0).getAttribute('data-unit-id'))!;
  const u2 = (await rows.nth(1).getAttribute('data-unit-id'))!;

  // ── 章を作る。作っている間は、ジョブの進み具合が目次に出る ──
  t.setFake({ kinds: { chapter_body: ['slow'] }, slowMs: 1500 });
  await row(page, u1).getByTestId('tb-create').click();
  await expect(row(page, u1).getByTestId('tb-status')).toHaveText('作成中');
  await expect(row(page, u1).getByTestId('tb-progress')).toContainText('本文を書いています');
  await expect(page.getByTestId('jobbar-running')).toHaveText('実行中 1');
  await expect(row(page, u1).getByTestId('tb-status')).toHaveText('完成', { timeout: 15000 });
  await expect(row(page, u1)).toContainText('厚さ: 標準(第 1 版)');
  await expect(row(page, u1).getByTestId('tb-quiz')).toContainText('確認問題: 3 問(まだ解いていません)');
  await expect(page.getByTestId('tb-summary')).toHaveText('完成 1 / 44 章・既読 0 章');
  expect(existsSync(join(textbookDir, 'chapters', `${u1}.md`))).toBe(true);
  expect(existsSync(join(textbookDir, 'review', `${u1}.json`))).toBe(true);

  // ── 読む: Markdown+KaTeX、例題(解答・解説つき)、確認問題。前後の章へ移れる ──
  await row(page, u1).getByTestId('tb-open').click();
  await expect(page.getByTestId('screen-chapter')).toBeVisible();
  await expect(page.getByTestId('chapter-title')).toHaveText('第1章 整式の割り算と分数式');
  await expect(page.getByTestId('chapter-status')).toHaveText('完成');
  const body = page.getByTestId('chapter-body');
  for (const h of ['導入', '要点', '例題', 'よくある誤り', '確認問題']) await expect(body.locator('h2', { hasText: h })).toHaveCount(1);
  await expect(page.getByTestId('chapter-intro')).toContainText('第1章では「整式の割り算と分数式」を学びます');
  await expect(page.getByTestId('chapter-points').locator('.katex').first()).toBeVisible();
  await expect(page.getByTestId('chapter-example')).toHaveCount(2);
  await expect(page.getByTestId('chapter-example').first()).toContainText('解答');
  await expect(page.getByTestId('chapter-example').first()).toContainText('解説');
  await expect(page.getByTestId('chapter-example').first()).toContainText('ねらい');
  await expect(page.getByTestId('chapter-quiz-item')).toHaveCount(3);
  await expect(page.getByTestId('chapter-review')).toContainText('誤りの指摘なし');
  await expect(page.getByTestId('chapter-prev')).toBeDisabled();
  // 次の章(まだ作っていない)へ → そこから作れる。図つきの章にする
  await page.getByTestId('chapter-next').click();
  await expect(page.getByTestId('chapter-title')).toContainText('第2章');
  await expect(page.getByTestId('chapter-empty')).toContainText('まだ作っていません');
  t.setFake({ kinds: { chapter_body: ['with_figure'], chapter_review: ['issues'] } });
  await page.getByTestId('chapter-create').click();
  await expect(page.getByTestId('chapter-body')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('chapter-figure').locator('img')).toHaveCount(1); // 図は SVG(img として表示)
  await expect(page.getByTestId('chapter-figure')).toContainText('直角三角形の図');
  await expect(page.getByTestId('chapter-points')).toContainText('点検の指摘 1 件を反映して直しました');
  await expect(page.getByTestId('chapter-review')).toContainText('指摘 1 件(直してあります)');
  await page.getByTestId('chapter-prev').click();
  await expect(page.getByTestId('chapter-title')).toContainText('第1章');

  // ── 既読にする ──
  await expect(page.getByTestId('chapter-read-badge')).toHaveCount(0);
  await page.getByTestId('chapter-read').click();
  await expect(page.getByTestId('chapter-read-badge')).toBeVisible();
  await expect(page.getByTestId('chapter-read')).toHaveText('既読を外す');

  // ── PDF: この章だけ ──
  await page.getByTestId('chapter-export').click();
  await expect(page.getByTestId('chapter-export-path')).toContainText(`${u1}.pdf`);
  const one = await pdfInfo(join(textbookDir, 'pdf', `${u1}.pdf`));
  expect(one.pages).toBeGreaterThanOrEqual(1);
  for (const w of ['第1章', '導入', '要点', '例題1', '解答', 'よくある誤り', '確認問題']) expect(one.text, w).toContain(w);
  expect(one.text).not.toContain('第2章 ');

  // ── 目次に戻る: 既読・未習の切り替え、科目全体の PDF ──
  await page.getByTestId('chapter-toc').click();
  await expect(page.getByTestId('tb-summary')).toHaveText('完成 2 / 44 章・既読 1 章');
  await expect(row(page, u1)).toHaveAttribute('data-read', 'true');
  await expect(row(page, u1).getByTestId('tb-read')).toBeChecked();
  // チェックボックスは保存後の目次で切り替わる(制御された入力)ので、click して結果を待つ
  await row(page, u2).getByTestId('tb-read').click();
  await expect(page.getByTestId('tb-summary')).toHaveText('完成 2 / 44 章・既読 2 章');
  await expect(row(page, u2).getByTestId('tb-read')).toBeChecked();
  await row(page, u2).getByTestId('tb-read').click();
  await expect(page.getByTestId('tb-summary')).toHaveText('完成 2 / 44 章・既読 1 章');
  // 未習の印: 作った章に付けると「作り直しを提案」、未作成の章は「作ると: 詳しい」
  await row(page, u2).getByTestId('tb-unlearned').click();
  await expect(row(page, u2).getByTestId('tb-status')).toHaveText('作り直しを提案');
  await expect(row(page, u2).getByTestId('tb-stale')).toContainText('未習');
  const u3 = (await rows.nth(2).getAttribute('data-unit-id'))!;
  await row(page, u3).getByTestId('tb-unlearned').click();
  await expect(row(page, u3)).toContainText('作ると: 詳しい');
  await page.getByTestId('tb-export-all').click();
  await expect(page.getByTestId('tb-export-path')).toContainText('textbook.pdf');
  const all = await pdfInfo(join(textbookDir, 'pdf', 'textbook.pdf'));
  expect(all.pages).toBeGreaterThanOrEqual(2);
  expect(all.text).toContain('作成済みの章: 2 章');
  expect(all.text).toContain('第2章');

  // ── 再起動後も残る ──
  t = await t.relaunch();
  page = t.page;
  await page.getByTestId('project-card').click();
  await page.getByTestId('subject-card').click();
  await page.getByTestId('tab-textbook').click();
  await expect(page.getByTestId('tb-summary')).toHaveText('完成 2 / 44 章・既読 1 章');
  await expect(row(page, u1).getByTestId('tb-status')).toHaveText('完成');
  await expect(row(page, u1).getByTestId('tb-read')).toBeChecked();
  await expect(row(page, u2).getByTestId('tb-status')).toHaveText('作り直しを提案');
  await expect(row(page, u2).getByTestId('tb-unlearned')).toBeChecked();
  await expect(row(page, u3).getByTestId('tb-unlearned')).toBeChecked();
  await row(page, u1).getByTestId('tb-open-title').click();
  await expect(page.getByTestId('chapter-read-badge')).toBeVisible();
  await expect(page.getByTestId('chapter-example')).toHaveCount(2);
  const toc = JSON.parse(readFileSync(join(textbookDir, 'toc.json'), 'utf8'));
  expect(toc.chapters[0]).toMatchObject({ unitId: u1, status: 'done', read: true, chapterVersion: 1 });
  expect(toc.chapters[1]).toMatchObject({ unitId: u2, status: 'stale', unlearned: true });

  // ── 作り直す: 前の版が残る ──
  await page.getByTestId('chapter-next').click();
  await expect(page.getByTestId('chapter-stale')).toContainText('未習');
  await page.getByTestId('chapter-rebuild').click();
  await expect(page.getByTestId('chapter-meta')).toContainText('第 2 版', { timeout: 15000 });
  await expect(page.getByTestId('chapter-meta')).toContainText('未習の単元として作成');
  await expect(page.getByTestId('chapter-meta')).toContainText('前の版 1 つを保存');
  await expect(page.getByTestId('chapter-example')).toHaveCount(4);
  await expect(page.getByTestId('chapter-status')).toHaveText('完成');
  expect(existsSync(join(textbookDir, 'versions', `${u2}.v1.md`))).toBe(true);
  await t.app.close();
});

test('教材: まとめて作る(呼び出しの見込み数を見せて確認 → 1日の上限を超える分は翌日に回す)。失敗した章はもう一度試せる', async () => {
  const t = await launchApp();
  const { page } = t;
  await createProject(page, { university: 'ダミー大学', faculty: '工学部', examDate: '2027-02-25', subjects: ['数学II・B・C'] });
  // 1日の上限を 12 回にする(1章 5 回が目安なので、今日は 2 章)
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('s-dailyLimit').fill('12');
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
  await page.getByTestId('nav-dashboard').click();
  await page.getByTestId('subject-card').click();
  await page.getByTestId('tab-textbook').click();
  await expect(page.getByTestId('tb-row')).toHaveCount(44);

  // 見込みを見せて、確認を取る(見るだけでは始まらない)
  await page.getByTestId('tb-build-all').click();
  await expect(page.getByTestId('tb-plan')).toContainText('未作成の 44 章');
  await expect(page.getByTestId('tb-plan-calls')).toHaveText('約 220 回');
  await expect(page.getByTestId('tb-plan-later')).toContainText('今日は 2 章まで作り、残りの 42 章は');
  await expect(page.getByTestId('jobbar-running')).toHaveText('実行中 0');
  await page.getByTestId('tb-plan-cancel').click();
  await expect(page.getByTestId('tb-plan')).toHaveCount(0);
  await expect(page.locator('[data-testid="tb-row"][data-status="none"]')).toHaveCount(44);

  // 始める → 2 章できて、残りは翌日以降に回る
  await page.getByTestId('tb-build-all').click();
  await page.getByTestId('tb-plan-start').click();
  await expect(page.locator('[data-testid="tb-row"][data-status="done"]')).toHaveCount(2, { timeout: 20000 });
  await expect(page.getByTestId('tb-deferred')).toContainText('あと 42 章は、1日の上限のため翌日以降に自動で作ります');
  await expect(page.getByTestId('tb-row').nth(2)).toContainText('翌日以降に作成');
  await expect(page.getByTestId('tb-summary')).toHaveText('完成 2 / 44 章・既読 0 章');
  await page.getByTestId('tb-deferred-cancel').click();
  await expect(page.getByTestId('tb-deferred')).toHaveCount(0);

  // 失敗した章は、理由が出て、もう一度試せる
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('s-dailyLimit').fill('200');
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
  await page.getByTestId('nav-dashboard').click();
  await page.getByTestId('subject-card').click();
  await page.getByTestId('tab-textbook').click();
  t.setFake({ kinds: { chapter_review: ['usage_limit'] } });
  await page.getByTestId('tb-row').nth(2).getByTestId('tb-create').click();
  await expect(page.getByTestId('job-failure')).toHaveAttribute('data-failure', 'usage_limit', { timeout: 15000 });
  await expect(page.getByTestId('tb-row').nth(2).getByTestId('tb-status')).toHaveText('未作成');
  await page.getByTestId('job-retry').click();
  await expect(page.getByTestId('tb-row').nth(2).getByTestId('tb-status')).toHaveText('完成', { timeout: 15000 });
  await expect(page.getByTestId('job-failure')).toHaveCount(0);

  // 設定の「品質」欄に、教材の点検の数が出る
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('q-textbook')).toContainText('点検 3 回のうち、指摘あり 0 回');
  await t.app.close();
});
