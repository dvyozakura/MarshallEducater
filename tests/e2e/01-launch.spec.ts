import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers';

test('アプリが起動してウィンドウが出る', async () => {
  const { app, page } = await launchApp();
  await expect(page.getByTestId('app-title')).toHaveText('MarshallEducater');
  expect(await app.evaluate(({ app: a }) => a.getName())).toBeTruthy();
  // 開発時の起動でも、ウィンドウ用のアイコン(out/icon.ico)が読める
  const icon = await app.evaluate(({ nativeImage }, file) => {
    const img = nativeImage.createFromPath(file);
    return { empty: img.isEmpty(), width: img.getSize().width };
  }, join(repoRoot, 'out', 'icon.ico'));
  expect(icon.empty).toBe(false);
  expect(icon.width).toBeGreaterThanOrEqual(16);
  await app.close();
});
