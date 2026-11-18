import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, launchApp } from './helpers';

/** 章の要点の中の文字列を選び、マウスを離したことにする(人がドラッグで選ぶのと同じ)。 */
async function selectInPoints(page: Page, phrase: string) {
  await page.evaluate((text) => {
    const root = document.querySelector('[data-testid="chapter-points"]')!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const i = node.textContent!.indexOf(text);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + text.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      node.parentElement!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return;
    }
    throw new Error(`本文に「${text}」が見つかりません`);
  }, phrase);
}

test('教材への質問: 文章を選んで「ここを質問」→ 2往復 → 再起動後も会話が残る → 教材に反映で章が更新される。科目全体の質問もできる', async () => {
  let t = await launchApp();
  let page = t.page;
  await createProject(page, { university: 'ダミー大学', faculty: '理学部', examDate: '2027-02-25', subjects: ['数学II・B・C'] });
  const textbookDir = join(t.dataDir, 'ダミー大学 理学部', 'subjects', '数学II・B・C', 'textbook');
  await page.getByTestId('subject-card').click();
  await page.getByTestId('tab-textbook').click();
  const first = page.getByTestId('tb-row').first();
  const u1 = (await first.getAttribute('data-unit-id'))!;
  await first.getByTestId('tb-create').click();
  await expect(first.getByTestId('tb-status')).toHaveText('完成', { timeout: 15000 });
  await first.getByTestId('tb-open').click();

  // ── 章の横に質問欄。最初は空 ──
  const panel = page.getByTestId('tchat-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('tchat-empty')).toContainText('ここを質問');
  await expect(page.getByTestId('tchat-supplement')).toHaveCount(0); // 答えが付くまでは反映できない

  // ── 文章を選んで「ここを質問」 ──
  await selectInPoints(page, '直角三角形で、斜辺の長さを求める');
  await page.getByTestId('ask-here').click();
  await expect(page.getByTestId('tchat-quote')).toContainText('直角三角形で、斜辺の長さを求める');
  await expect(page.getByTestId('tchat-input')).toBeFocused();
  await page.getByTestId('tchat-input').fill('なぜ斜辺なのですか?');
  await page.getByTestId('tchat-send').click();
  const msgs = page.getByTestId('tchat-msg');
  await expect(msgs).toHaveCount(2, { timeout: 15000 });
  await expect(msgs.nth(0)).toContainText('直角三角形で、斜辺の長さを求める'); // 引用が残る
  await expect(msgs.nth(1)).toContainText('選んだ箇所「直角三角形で、斜辺の長さを求める」について');
  await expect(msgs.nth(1)).toContainText('を踏まえています');
  await expect(msgs.nth(1).locator('.katex').first()).toBeVisible();
  await expect(page.getByTestId('tchat-quote')).toHaveCount(0); // 送ったら引用は消える

  // ── 2往復目(続き) ──
  await page.getByTestId('tchat-input').fill('もう少し例をください');
  await page.getByTestId('tchat-send').click();
  await expect(msgs).toHaveCount(4, { timeout: 15000 });
  await expect(msgs.nth(3)).toContainText('これまでのやりとり: 2 件');

  // ── 再起動後も会話が残る(章を開くと続きから) ──
  t = await t.relaunch();
  page = t.page;
  await page.getByTestId('project-card').click();
  await page.getByTestId('subject-card').click();
  await page.getByTestId('tab-textbook').click();
  await page.locator(`[data-testid="tb-row"][data-unit-id="${u1}"]`).getByTestId('tb-open').click();
  await expect(page.getByTestId('tchat-msg')).toHaveCount(4);
  await expect(page.getByTestId('tchat-msg').nth(0)).toContainText('なぜ斜辺なのですか?');

  // ── 教材に反映: 補足が章に足され、版が上がる。前の版は残る ──
  await expect(page.getByTestId('chapter-supplement')).toHaveCount(0);
  await page.getByTestId('tchat-supplement').click();
  await expect(page.getByTestId('tchat-supplement-done')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('chapter-supplement')).toHaveCount(1);
  await expect(page.getByTestId('chapter-supplement')).toContainText('「なぜ斜辺なのですか?」についての補足');
  await expect(page.getByTestId('chapter-supplement')).toContainText('選んだ箇所: 「直角三角形で、斜辺の長さを求める」');
  await expect(page.getByTestId('chapter-meta')).toContainText('第 2 版');
  await expect(page.getByTestId('chapter-meta')).toContainText('前の版 1 つを保存');
  await expect(page.getByTestId('chapter-review')).toContainText('誤りの指摘なし');
  expect(existsSync(join(textbookDir, 'versions', `${u1}.v1.json`))).toBe(true);

  // 次の章へ移ると、その章の会話(まだ無い)になる
  await page.getByTestId('chapter-next').click();
  await expect(page.getByTestId('chapter-empty')).toBeVisible();
  await page.getByTestId('chapter-prev').click();
  await expect(page.getByTestId('tchat-msg')).toHaveCount(4);
  // 新しい会話を始められる
  await page.getByTestId('tchat-new').click();
  await expect(page.getByTestId('tchat-msg')).toHaveCount(0);

  // ── 「教材」タブから、科目全体について質問 ──
  await page.getByTestId('chapter-toc').click();
  await page.getByTestId('tb-ask').click();
  await expect(page.getByTestId('tchat-panel')).toContainText('教材について質問(科目全体)');
  await page.getByTestId('tchat-input').fill('どの章から読めばいいですか?');
  await page.getByTestId('tchat-send').click();
  await expect(page.getByTestId('tchat-msg')).toHaveCount(2, { timeout: 15000 });
  await expect(page.getByTestId('tchat-msg').nth(1)).toContainText('教材の目次(44 章)を踏まえています');
  await expect(page.getByTestId('tchat-supplement')).toHaveCount(0); // 科目全体の質問は、章に反映しない
  await t.app.close();
});
