import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { testDatabase } from '../../../../tests/helpers/postgres';
import { buildApp } from '../../../api/src/app';
import { readConfig } from '../../../api/src/config';
import { AuthService } from '../../../api/src/modules/auth/service';
import type { FastifyInstance } from 'fastify';
import { seedCatalog,catalogTeamId,catalogPlayerId } from '../../../../tests/helpers/catalog';
import {sql} from '../../../../packages/db/src/index';

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
  await expect(page.getByText('Тег: SYN',{exact:true})).toBeVisible();
  const catalogue=page.getByRole('table',{name:'Результаты поиска: Команды',exact:true});
  await expect(catalogue.getByText('Внутренний ID: '+catalogTeamId,{exact:true})).not.toBeVisible();
  const first=catalogue.getByRole('row').filter({has:page.getByText('Тег: SYN',{exact:true})});
  await first.getByText('Данные записи',{exact:true}).click();await expect(first).toContainText('Внутренний ID: '+catalogTeamId);
  await first.getByText('Данные записи',{exact:true}).click();
  await page.screenshot({path:'test-results/catalog-desktop.png',fullPage:true});
  await page.getByRole('link',{name:'Synthetic Aurora',exact:true}).first().click();
  await expect(page).toHaveURL(new RegExp('/teams/'+catalogTeamId+'$'));
  await expect(page.getByRole('region',{name:'Состав по OpenDota',exact:true})).toContainText('не сопоставлена');
  const entity=page.getByRole('region',{name:'Карточка организации',exact:true});
  await expect(entity.getByText('Внутренний ID: '+catalogTeamId,{exact:true})).not.toBeVisible();
  await expect(entity).toContainText('Тег команды: SYN');
  await expect(page.getByText('Карта 8002',{exact:false})).toContainText('Dire');
  await expect(page.locator('li')).toHaveCount(5);
  await page.getByRole('link',{name:'Synthetic Twin',exact:true}).first().click();
  await expect(page).toHaveURL(new RegExp('/players/'+catalogPlayerId+'$'));
  await expect(page.getByRole('region',{name:'Карточка игрока',exact:true}).getByText('Внутренний ID: '+catalogPlayerId,{exact:true})).not.toBeVisible();
  await expect(page.getByText('Steam32 в записи каталога:',{exact:false})).toContainText('1000');
  await expect(page.getByText('Canonical player ID:',{exact:false})).toHaveCount(0);
  await page.reload();await expect(page.getByRole('heading',{name:'Synthetic Twin',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'К справочникам',exact:false}).click();
  await page.setViewportSize({width:360,height:800});
  await page.getByRole('button',{name:'Герои',exact:true}).click();
  await expect(page.getByRole('cell',{name:'Synthetic Hero',exact:false})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/catalog-mobile.png',fullPage:true});
  await catalogueNameCases(page);
});
test('catalogue empty/error/retry states and expired session remove private views',async({page})=>{
  await enter(page);
  await page.getByLabel('Имя, тег или ID').fill('no-such-synthetic-team');await page.getByRole('button',{name:'Найти',exact:true}).click();
  await expect(page.getByText('Ничего не найдено.',{exact:false})).toBeVisible();
  await page.route('**/api/v1/team-directory?**',route=>route.fulfill({status:503,body:'Synthetic failure'}));
  await page.getByRole('button',{name:'Перечитать базу',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Не удалось загрузить');
  await page.unroute('**/api/v1/team-directory?**');await page.getByRole('button',{name:'Повторить',exact:true}).click();
  await expect(page.getByText('Ничего не найдено.',{exact:false})).toBeVisible();
  await page.route('**/api/v1/team-directory?**',route=>route.fulfill({status:401,body:'Synthetic expired session'}));
  await page.getByRole('button',{name:'Перечитать базу',exact:true}).click();
  await expect(page).toHaveURL(/\/login$/);await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toHaveCount(0);
});

// Reuse the catalogue login: the complete auth suite must respect the real 5/min limit.
async function catalogueNameCases(page:import('@playwright/test').Page){
  const unsafe='<img src=x onerror=window.syntheticCatalogueXss=1> Synthetic unsafe nickname';
  await sql`INSERT INTO teams(id,name) VALUES(12345,'')`.execute(database.db);
  await sql`INSERT INTO players(id,nickname) VALUES(12346,''),(12347,${unsafe})`.execute(database.db);
  await page.getByRole('button',{name:'Игроки',exact:true}).click();
  await page.getByLabel('Имя, тег или ID').fill('Synthetic Twin');await page.getByRole('button',{name:'Найти',exact:true}).click();
  const catalogue=page.getByRole('table',{name:'Результаты поиска: Игроки',exact:true});
  await expect(catalogue.getByRole('link',{name:'Synthetic Twin',exact:true})).toHaveCount(2);
  await expect(catalogue.getByText('Имя повторяется. Проверьте аккаунт в карточке.',{exact:true})).toHaveCount(2);
  await expect(catalogue.locator(`a[href="/players/${catalogPlayerId}"]`)).toBeVisible();
  await expect(catalogue.getByText('Внутренний ID: '+catalogPlayerId,{exact:true})).not.toBeVisible();
  await page.getByLabel('Имя, тег или ID').fill('unsafe nickname');await page.getByRole('button',{name:'Найти',exact:true}).click();
  await expect(catalogue.getByRole('link',{name:unsafe,exact:true})).toBeVisible();expect(await page.evaluate(()=>Object.hasOwn(window,'syntheticCatalogueXss'))).toBe(false);
  await page.getByLabel('Имя, тег или ID').fill('12346');await page.getByRole('button',{name:'Найти',exact:true}).click();
  await catalogue.getByRole('link',{name:'Игрок без ника',exact:true}).click();await expect(page.getByRole('heading',{name:'Игрок без ника',exact:true})).toBeVisible();
  await page.goto('/teams/12345');await expect(page.getByRole('heading',{name:'Команда без названия',exact:true})).toBeVisible();
  const entity=page.getByRole('region',{name:'Карточка организации',exact:true});await expect(entity.getByText('Внутренний ID: 12345',{exact:true})).not.toBeVisible();
  await entity.getByText('Данные записи',{exact:true}).click();await expect(entity.getByText('Внутренний ID: 12345',{exact:true})).toBeVisible();
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
}

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
