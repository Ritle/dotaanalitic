import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { testDatabase } from '../../../../tests/helpers/postgres';
import { buildApp } from '../../../api/src/app';
import { readConfig } from '../../../api/src/config';
import { AuthService } from '../../../api/src/modules/auth/service';
import type { FastifyInstance } from 'fastify';

let database: Awaited<ReturnType<typeof testDatabase>>;
let api: FastifyInstance;
let password: string;
test.beforeAll(async () => {
  database = await testDatabase();
  password = randomBytes(24).toString('base64url');
  await new AuthService(database.db).provision('synthetic-browser-owner', password);
  api = await buildApp(readConfig({ DATABASE_URL: database.url, WEB_ORIGIN: 'http://127.0.0.1:5179' }), { db: database.db, logger: false });
  await api.listen({ host: '127.0.0.1', port: 3151 });
});
test.afterAll(async () => { await api?.close(); await database?.close(); });

test('private entry redirects to keyboard-accessible login at 360px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Вход владельца' })).toBeVisible();
  await expect(page.getByText('API:')).toContainText('доступен');
  await expect(page.getByRole('heading', { name: 'Личный кабинет' })).toHaveCount(0);
  await expect(page.getByLabel('Пароль')).toHaveAttribute('type', 'password');
  await page.getByLabel('Логин').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Пароль')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/auth-login-mobile.png', fullPage: true });
});

test('real PostgreSQL login, reload, CSRF logout and back navigation', async ({ page, context }) => {
  await page.goto('/login');
  await page.getByLabel('Логин').fill('synthetic-browser-owner');
  await page.getByLabel('Пароль').fill('wrong-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Неверный логин');
  await expect(page.getByLabel('Пароль')).toHaveValue('');
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:5179/');
  await expect(page.getByRole('heading', { name: 'Личный кабинет' })).toBeVisible();
  await expect(page.getByText('Прогноз недоступен:')).toBeVisible();
  const cookie = (await context.cookies()).find(value => value.name === 'dota_session');
  expect(cookie?.httpOnly).toBe(true);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Личный кабинет' })).toBeVisible();
  // Add a second history entry: authenticated /login redirects back home.
  // Login/logout intentionally use replace, so otherwise Back leaves the app.
  await page.goto('/login');
  await expect(page).toHaveURL('http://127.0.0.1:5179/');
  await page.screenshot({ path: 'test-results/auth-dashboard.png', fullPage: true });
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/login$/);
  expect((await context.request.get('/api/v1/auth/me')).status()).toBe(401);
});
