import { expect, test } from '@playwright/test';
import { launchApp } from './helpers';

test('アプリが起動してウィンドウが出る', async () => {
  const { app, page } = await launchApp();
  await expect(page.getByTestId('app-title')).toHaveText('MarshallEducater');
  expect(await app.evaluate(({ app: a }) => a.getName())).toBeTruthy();
  await app.close();
});
