import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { testDatabase } from '../../../../tests/helpers/postgres';
import { buildApp } from '../../../api/src/app';
import { readConfig } from '../../../api/src/config';
import { AuthService } from '../../../api/src/modules/auth/service';
import type { FastifyInstance } from 'fastify';
import { seedCatalog,catalogTeamId,catalogPlayerId } from '../../../../tests/helpers/catalog';

let database: Awaited<ReturnType<typeof testDatabase>>;
let api: FastifyInstance;
let password: string;
test.beforeAll(async () => {
  database = await testDatabase();
  await seedCatalog(database.db);
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
  await expect(page.getByRole('region', { name: 'Статус модели', exact: true })).toContainText('Нет активной проверенной модели.');
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

async function enter(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('Логин').fill('synthetic-browser-owner');
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();
}
test('catalogue search and organization/player overviews use real DB data at desktop and mobile',async({page})=>{
  await enter(page);
  await page.getByLabel('Имя, тег или ID').fill('Aurora');await page.getByRole('button',{name:'Найти',exact:true}).click();
  await expect(page.getByRole('link',{name:'Synthetic Aurora',exact:true})).toHaveCount(2);
  await expect(page.getByText('SYN · ID '+catalogTeamId,{exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/catalog-desktop.png',fullPage:true});
  await page.getByRole('link',{name:'Synthetic Aurora',exact:true}).first().click();
  await expect(page).toHaveURL(new RegExp('/teams/'+catalogTeamId+'$'));
  await expect(page.getByText('Актуальный состав неизвестен',{exact:false})).toBeVisible();
  await expect(page.getByText('Карта 8002',{exact:false})).toContainText('Dire');
  await expect(page.locator('li')).toHaveCount(5);
  await page.getByRole('link',{name:'Synthetic Twin · ID '+catalogPlayerId,exact:true}).click();
  await expect(page.getByText('Canonical player ID:',{exact:false})).toContainText(catalogPlayerId);
  await expect(page.getByText('Текущая команда неизвестна.',{exact:false})).toBeVisible();
  await page.reload();await expect(page.getByRole('heading',{name:'Synthetic Twin',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'К справочникам',exact:false}).click();
  await page.setViewportSize({width:360,height:800});
  await page.getByRole('button',{name:'Герои',exact:true}).click();
  await expect(page.getByRole('cell',{name:'Synthetic Hero',exact:false})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/catalog-mobile.png',fullPage:true});
});
test('catalogue empty/error/retry states and expired session remove private views',async({page})=>{
  await enter(page);
  await page.getByLabel('Имя, тег или ID').fill('no-such-synthetic-team');await page.getByRole('button',{name:'Найти',exact:true}).click();
  await expect(page.getByText('Ничего не найдено.',{exact:false})).toBeVisible();
  await page.route('**/api/v1/teams?**',route=>route.fulfill({status:503,body:'Synthetic failure'}));
  await page.getByRole('button',{name:'Перечитать базу',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Не удалось загрузить');
  await page.unroute('**/api/v1/teams?**');await page.getByRole('button',{name:'Повторить',exact:true}).click();
  await expect(page.getByText('Ничего не найдено.',{exact:false})).toBeVisible();
  await page.route('**/api/v1/teams?**',route=>route.fulfill({status:401,body:'Synthetic expired session'}));
  await page.getByRole('button',{name:'Перечитать базу',exact:true}).click();
  await expect(page).toHaveURL(/\/login$/);await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toHaveCount(0);
});

test('pro-map filters show raw map counts, native side, unknown coverage and nullable empty rates',async({page})=>{
  await enter(page);await page.goto('/teams/'+catalogTeamId);
  await expect(page.getByRole('heading',{name:'Профессиональные карты',exact:true})).toBeVisible();
  await expect(page.getByRole('group',{name:'Показатели выборки'})).toContainText('N = 2');
  await expect(page.getByRole('group',{name:'Показатели выборки'})).toContainText('50');
  await page.getByLabel('Сторона карты').selectOption('dire');await page.getByRole('button',{name:'Применить фильтры',exact:true}).click();
  await expect(page.getByRole('group',{name:'Показатели выборки'})).toContainText('N = 1');
  await expect(page.getByRole('table',{name:'Выбранные профессиональные карты'})).toContainText('Dire · Поражение');
  await page.screenshot({path:'test-results/pro-maps-desktop.png',fullPage:true});
  await page.setViewportSize({width:360,height:800});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/pro-maps-mobile.png',fullPage:true});
  await page.getByLabel('ID проверенного патча').fill('999');await page.getByRole('button',{name:'Применить фильтры',exact:true}).click();
  await expect(page.getByRole('group',{name:'Показатели выборки'})).toContainText('N = 0');
  await expect(page.getByText('При N = 0 частота побед неизвестна.',{exact:false})).toBeVisible();
  await page.getByLabel('Подтверждённая роль').selectOption('1');await page.getByRole('button',{name:'Применить фильтры',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Некорректные фильтры');
});
