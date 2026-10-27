import { test, expect } from '@playwright/test';
test('starter shell reports API availability; never pretends to return predictions', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Dota 2 Pro Analytics'})).toBeVisible();
  await expect(page.getByText('API:')).toContainText('доступен');
  await expect(page.getByText('Демонстрационных прогнозов нет.')).toBeVisible();
});
