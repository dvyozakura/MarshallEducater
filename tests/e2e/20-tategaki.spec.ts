import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, launchApp, repoRoot } from './helpers';

export const shotsDir = join(repoRoot, 'Logs', 'shots');

test('組み方向: 国語は既定で縦書き、科目の設定で変えられる。縦書きの表示部品(縦中横・スクロール・文字の大きさ)', async () => {
  mkdirSync(shotsDir, { recursive: true });
  let t = await launchApp();
  let { page } = t;
  await t.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 800));
  await createProject(page, { university: 'ダミー大学', faculty: '文学部', examDate: '2027-02-25', subjects: ['現代文', '数学I・A'] });

  // 国語の科目は縦書き、数学は横書き
  await page.getByTestId('subject-card').filter({ hasText: '数学I・A' }).click();
  await expect(page.getByTestId('subject-writing')).toHaveText('横書き');
  await page.getByTestId('nav-home').click();
  await page.getByTestId('project-card').first().click();
  await page.getByTestId('subject-card').filter({ hasText: '現代文' }).click();
  await expect(page.getByTestId('subject-writing')).toHaveText('縦書き');

  await page.getByTestId('subject-settings-toggle').click();
  await expect(page.getByTestId('writing-mode')).toHaveValue('vertical');
  const sample = page.getByTestId('writing-sample');
  await expect(sample).toHaveAttribute('data-writing', 'vertical');
  expect(await sample.evaluate((el) => getComputedStyle(el).writingMode)).toBe('vertical-rl');
  // 2桁までの数字は縦中横、4桁はそのまま
  await expect(sample.locator('.tcy').filter({ hasText: /^12$/ })).toHaveCount(1);
  expect(await sample.locator('.tcy').first().evaluate((el) => getComputedStyle(el).textCombineUpright)).toBe('all');
  await expect(sample).toContainText('2026年');
  await expect(sample.locator('ruby')).toHaveCount(1);
  await sample.screenshot({ path: join(shotsDir, 's3-2-sample-18px.png') });

  // 文字を大きくすると、横にはみ出して横方向に読み進める
  for (let i = 0; i < 3; i++) await page.getByTestId('tate-fs-up').click();
  await expect(page.getByTestId('tate-fs-value')).toHaveText('28px');
  await page.waitForTimeout(100);
  const size = await sample.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, sl: el.scrollLeft }));
  expect(size.sw).toBeGreaterThan(size.cw);
  expect(size.sl).toBe(0); // 先頭は右端
  await sample.screenshot({ path: join(shotsDir, 's3-2-sample-28px-start.png') });
  // ホイールを下へ → 左へ進む
  await sample.hover();
  await page.mouse.wheel(0, 200);
  await expect.poll(() => sample.evaluate((el) => el.scrollLeft)).toBeLessThan(0);
  // Home で先頭、End で末尾
  await sample.focus();
  await page.keyboard.press('Home');
  await expect.poll(() => sample.evaluate((el) => el.scrollLeft)).toBe(0);
  await page.keyboard.press('End');
  await expect.poll(() => sample.evaluate((el) => Math.round(el.scrollLeft + el.scrollWidth - el.clientWidth))).toBeLessThanOrEqual(1);
  await sample.screenshot({ path: join(shotsDir, 's3-2-sample-28px-end.png') });
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => sample.evaluate((el) => Math.round(el.scrollLeft + el.scrollWidth - el.clientWidth))).toBeGreaterThan(1);
  for (let i = 0; i < 3; i++) await page.getByTestId('tate-fs-down').click();
  await page.screenshot({ path: join(shotsDir, 's3-2-subject-kokugo.png') });

  // 横書きに変える → 保存される
  await page.getByTestId('writing-mode').selectOption('horizontal');
  await expect(page.getByTestId('subject-writing')).toHaveText('横書き');
  await expect(page.getByTestId('writing-sample')).not.toHaveAttribute('data-writing', 'vertical');
  const projectFile = join(t.dataDir, 'ダミー大学 文学部', 'project.json');
  let pj = JSON.parse(readFileSync(projectFile, 'utf8'));
  expect(pj.subjects.find((s: { name: string }) => s.name === '現代文').writingMode).toBe('horizontal');

  // 既存のプロジェクト(組み方向の無い古い形式)も、読み込み時に国語は縦書きになる
  pj = { ...pj, subjects: pj.subjects.map((s: { id: string; name: string }) => ({ id: s.id, name: s.name })) };
  writeFileSync(projectFile, JSON.stringify(pj, null, 2), 'utf8');
  t = await t.relaunch();
  page = t.page;
  await page.getByTestId('project-card').first().click();
  await page.getByTestId('subject-card').filter({ hasText: '現代文' }).click();
  await expect(page.getByTestId('subject-writing')).toHaveText('縦書き');
  await t.app.close();
});

test('縦書きの記法: 一覧と、現代文・古文・漢文の見本(自作)を縦書きで表示。横書きでも壊れない', async () => {
  mkdirSync(shotsDir, { recursive: true });
  const t = await launchApp();
  const { page } = t;
  await createProject(page, { university: 'ダミー大学', faculty: '文学部', examDate: '2027-02-25', subjects: ['漢文'] });
  await page.getByTestId('subject-card').click();
  await page.getByTestId('subject-settings-toggle').click();
  await page.getByTestId('notation-help-toggle').click();
  await expect(page.getByTestId('notation-row')).toHaveCount(13);
  // 記法が文字のまま残っていない
  for (const id of ['sample-gendaibun', 'sample-kobun', 'sample-kanbun']) {
    const el = page.getByTestId(id);
    await expect(el).toHaveAttribute('data-writing', 'vertical');
    const text = await el.innerText();
    expect(text).not.toContain('{{');
    expect(text).not.toContain('[_');
    expect(text).not.toContain(':::');
    await el.screenshot({ path: join(shotsDir, `s3-3-${id}.png`) });
  }
  const g = page.getByTestId('sample-gendaibun');
  await expect(g.locator('.nt-line-solid')).toHaveCount(1);
  await expect(g.locator('.nt-line-wavy')).toHaveCount(1);
  await expect(g.locator('.nt-line-double')).toHaveCount(1);
  await expect(g.locator('.nt-dots')).toHaveCount(1);
  await expect(g.locator('.nt-blank')).toHaveCount(1);
  await expect(g.locator('.nt-para')).toHaveCount(3);
  await expect(g.locator('.nt-notedef')).toHaveCount(1);
  // 傍線は字の右(縦書きのとき)
  expect(await g.locator('.nt-line-text').first().evaluate((el) => getComputedStyle(el).textUnderlinePosition)).toContain('right');
  const k = page.getByTestId('sample-kanbun');
  await expect(k.locator('.kanbun')).toHaveCount(3);
  await expect(k.locator('[data-kind="白文"]')).toHaveCount(1);
  await expect(k.locator('[data-kind="訓読文"] .kb-kaeri').filter({ hasText: '三' })).toHaveCount(2);
  await expect(k.locator('.nt-saidoku')).toHaveCount(1);
  // 送り仮名は字の右、返り点は字の左(縦書き)
  const pos = await k.locator('[data-kind="訓読文"] .kb-u').nth(1).evaluate((u) => {
    const base = u.firstChild as Text;
    const r = document.createRange();
    r.selectNodeContents(base);
    const b = r.getBoundingClientRect();
    const ok = u.querySelector('.kb-okuri')!.getBoundingClientRect();
    const ka = u.querySelector('.kb-kaeri')!.getBoundingClientRect();
    return { baseCenter: (b.left + b.right) / 2, okuri: (ok.left + ok.right) / 2, kaeri: (ka.left + ka.right) / 2, baseBottom: b.bottom, okTop: ok.top };
  });
  expect(pos.okuri).toBeGreaterThan(pos.baseCenter);
  expect(pos.kaeri).toBeLessThan(pos.baseCenter);
  expect(pos.okTop).toBeGreaterThanOrEqual(pos.baseBottom - 2);
  await page.getByTestId('notation-help').screenshot({ path: join(shotsDir, 's3-3-notation-table.png') });

  // 横書きにしても、同じ記法が壊れずに出る
  await page.getByTestId('writing-mode').selectOption('horizontal');
  const hs = page.getByTestId('writing-sample');
  await expect(hs).not.toHaveAttribute('data-writing', 'vertical');
  expect(await hs.innerText()).not.toContain('{{');
  await expect(hs.locator('ruby')).toHaveCount(1);
  await expect(hs.locator('.nt-blank')).toHaveCount(1);
  await hs.screenshot({ path: join(shotsDir, 's3-3-horizontal-sample.png') });
  await t.app.close();
});
