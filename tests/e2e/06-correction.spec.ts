import { expect, test, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectPng, makePdf, MATH_HTML } from './fixtures';
import { createProject, launchApp } from './helpers';

const card = (page: Page, id: string) => page.locator(`[data-testid="pcard"][data-problem-id="${id}"]`);

test('補正画面: 読み取り → 編集・分割・結合・並べ替え・削除・図の範囲・読み直し → 確定 → 再起動後も残る', async () => {
  let t = await launchApp();
  let { page } = t;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const pdf = await makePdf(t.app, MATH_HTML, join(t.dataDir, '..', 'fixtures', 'math.pdf'));
  await createProject(page, { university: 'ダミー大学', faculty: '総合', examDate: '2027-02-25', subjects: ['数学II・B・C'] });

  // 取り込み → 補正画面 → 読み取り
  await page.getByTestId('nav-import').click();
  await page.getByTestId('import-file').setInputFiles([pdf]);
  await page.getByTestId('import-title').fill('ダミー模試 数学');
  await page.getByTestId('import-run').click();
  await page.getByTestId('import-open').click();
  await expect(page.getByTestId('screen-correction')).toBeVisible();
  await expect(page.getByTestId('not-read')).toBeVisible();
  await expect(page.getByTestId('page-img')).toBeVisible(); // 左に元のページ
  await page.getByTestId('read-start').click();
  await expect(page.getByTestId('pcard')).toHaveCount(2);
  await expect(page.getByTestId('corr-status')).toContainText('未確定');
  await expect(page.getByTestId('corr-count')).toHaveText('2 件(確定 0)');

  const sourcesDir = join(t.dataDir, 'ダミー大学 総合', 'subjects', '数学II・B・C', 'sources');
  const srcDir = join(sourcesDir, readdirSync(sourcesDir)[0]);
  const extracted = () => JSON.parse(readFileSync(join(srcDir, 'extracted.json'), 'utf8'));

  // 自信がない箇所: 色の印が付き、ボタンで飛べる(本文の該当部分が選ばれる)
  await expect(card(page, 'q002')).toHaveClass(/uncertain/);
  await expect(page.getByTestId('next-uncertain')).toContainText('残り 1');
  await page.getByTestId('next-uncertain').click();
  await expect(card(page, 'q002').getByTestId('c-body')).toBeVisible();
  await expect.poll(() => page.getByTestId('c-body').evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe('\\int_0^1');
  await expect(page.getByTestId('c-preview').locator('.katex-display')).toHaveCount(1); // 数式のプレビュー
  await page.getByTestId('unc-resolve').click();
  await expect(page.getByTestId('next-uncertain')).toContainText('残り 0');
  await expect(card(page, 'q002')).not.toHaveClass(/uncertain/);

  // 編集: 本文と配点を直す。プレビューがすぐ変わり、保存される
  await card(page, 'q001').getByTestId('pcard-head').click();
  const body = page.getByTestId('c-body');
  await expect(card(page, 'q001').getByTestId('c-body')).toBeVisible();
  await body.fill('前半の文。後半の文 $\\frac{3}{5}$ を求めよ。');
  await expect(page.getByTestId('c-preview').locator('.katex')).toHaveCount(1);
  await page.getByTestId('c-points').fill('25');
  await page.getByTestId('c-save').click();
  await expect(page.getByTestId('c-save')).toBeDisabled();
  await expect.poll(() => extracted().problems[0].points).toBe(25);
  expect(extracted().problems[0].body).toContain('\\frac{3}{5}');

  // 分割(カーソルの位置)→ 新しい問題を消す → もう一度分けて結合
  await body.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 5));
  await page.getByTestId('c-split').click();
  await expect(page.getByTestId('pcard')).toHaveCount(3);
  await expect(page.getByTestId('c-body')).toHaveValue('前半の文。');
  await card(page, 'q003').getByTestId('pcard-head').click();
  await expect(page.getByTestId('c-body')).toHaveValue('後半の文 $\\frac{3}{5}$ を求めよ。');
  await page.getByTestId('c-delete').click();
  await page.getByTestId('c-delete-yes').click();
  await expect(page.getByTestId('pcard')).toHaveCount(2);
  await card(page, 'q001').getByTestId('pcard-head').click();
  await page.getByTestId('c-body').fill('前半の文。後半の文。');
  await page.getByTestId('c-body').evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 5));
  await page.getByTestId('c-split').click(); // 編集中の内容は、操作の前に自動で保存される
  await expect(page.getByTestId('pcard')).toHaveCount(3);
  await page.getByTestId('c-merge').click();
  await expect(page.getByTestId('pcard')).toHaveCount(2);
  await expect(page.getByTestId('c-body')).toHaveValue('前半の文。\n後半の文。');

  // 並べ替え
  await page.getByTestId('c-down').click();
  await expect(page.getByTestId('pcard').first()).toHaveAttribute('data-problem-id', 'q002');
  await page.getByTestId('c-up').click();
  await expect(page.getByTestId('pcard').first()).toHaveAttribute('data-problem-id', 'q001');

  // 図の切り出し範囲: いまの範囲がページに重ねて出る。ドラッグで直すと、切り出し直される
  await expect(page.getByTestId('fig-box')).toHaveCount(1);
  await expect(page.getByTestId('fig-thumb')).toBeVisible();
  const oldImage: string = extracted().problems[0].figures[0].image;
  await page.getByTestId('fig-redraw').click();
  await expect(page.getByTestId('draw-hint')).toBeVisible();
  const box = (await page.getByTestId('page-img').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.6, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => extracted().problems[0].figures[0].image).not.toBe(oldImage);
  const fig = extracted().problems[0].figures[0];
  expect(fig.bbox.x).toBeCloseTo(0.2, 1);
  expect(fig.bbox.y).toBeCloseTo(0.3, 1);
  expect(fig.bbox.w).toBeCloseTo(0.6, 1);
  expect(fig.bbox.h).toBeCloseTo(0.3, 1);
  const png = await inspectPng(t.app, join(srcDir, fig.image));
  expect(png.width / png.height).toBeCloseTo(1.41, 1); // A4 の縦長ページの 60% × 30% → 横長の画像
  expect(existsSync(join(srcDir, oldImage))).toBe(false);
  await expect(page.getByTestId('draw-hint')).toHaveCount(0);

  // ヒント付きの部分再読み取り(選んだ1問だけ)
  await page.getByTestId('reread-hint').fill('2行目の分数は 3/5');
  await page.getByTestId('reread').click();
  await expect(page.getByTestId('c-body')).toHaveValue(/(読み直し: 2行目の分数は 3\/5)/);
  expect(extracted().problems[1].body).not.toContain('読み直し');

  // 問題ごとの確定 → 資料ごとの確定
  await page.getByTestId('c-confirm').click();
  await expect(card(page, 'q001')).toHaveAttribute('data-confirmed', 'true');
  await expect(page.getByTestId('corr-count')).toHaveText('2 件(確定 1)');
  await expect(page.getByTestId('corr-status')).toContainText('未確定');
  await page.getByTestId('confirm-source').click();
  await expect(page.getByTestId('source-confirmed')).toBeVisible();
  await expect(page.getByTestId('corr-status')).toHaveText('確定');
  await expect(page.getByTestId('corr-count')).toHaveText('2 件(確定 2)');

  // 補正の履歴が残る
  const corr = JSON.parse(readFileSync(join(srcDir, 'corrections.json'), 'utf8'));
  const actions: string[] = corr.entries.map((e: { action: string }) => e.action);
  for (const a of ['edit', 'split', 'delete', 'merge', 'reorder', 'figure', 'reread', 'confirm', 'confirm_all']) expect(actions, a).toContain(a);
  expect(corr.changedChars).toBeGreaterThan(0);
  expect(existsSync(join(srcDir, 'extracted.original.json'))).toBe(true);

  // 再起動後も残る
  t = await t.relaunch();
  page = t.page;
  await page.getByTestId('project-card').click();
  await page.getByTestId('subject-card').click();
  await page.getByTestId('tab-sources').click();
  await expect(page.getByTestId('source-status')).toHaveText('確定');
  await page.getByTestId('open-source').click();
  await expect(page.getByTestId('corr-status')).toHaveText('確定');
  await expect(page.getByTestId('pcard')).toHaveCount(2);
  await card(page, 'q001').getByTestId('pcard-head').click();
  await expect(page.getByTestId('c-body')).toHaveValue(/^前半の文。\n後半の文。\n.読み直し: 2行目/);
  await expect(page.getByTestId('c-points')).toHaveValue('25');

  // 確定のあとで直すと、確定が外れる(後の処理には使われなくなる)
  await page.getByTestId('c-body').fill('直した本文');
  await page.getByTestId('c-save').click();
  await expect(page.getByTestId('corr-status')).toContainText('未確定');
  await expect(card(page, 'q001')).toHaveAttribute('data-confirmed', 'false');
  await page.getByTestId('corr-back').click();
  await expect(page.getByTestId('source-status')).toContainText('未確定');
  expect(errors).toEqual([]);
  await t.app.close();
});
