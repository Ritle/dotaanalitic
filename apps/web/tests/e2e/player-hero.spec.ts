import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { testDatabase } from '../../../../tests/helpers/postgres';
import { buildApp } from '../../../api/src/app';
import { readConfig } from '../../../api/src/config';
import { AuthService } from '../../../api/src/modules/auth/service';
import type { FastifyInstance } from 'fastify';
import { catalogPlayerId } from '../../../../tests/helpers/catalog';
import { seedPlayerHeroes } from '../../../../tests/helpers/player-hero';

let database: Awaited<ReturnType<typeof testDatabase>>;
let api: FastifyInstance;
let password: string;
test.beforeAll(async () => {
  database = await testDatabase();
  await seedPlayerHeroes(database.db);
  password = randomBytes(24).toString('base64url');
  await new AuthService(database.db).provision('synthetic-browser-owner', password);
  api = await buildApp(readConfig({ DATABASE_URL: database.url, WEB_ORIGIN: 'http://127.0.0.1:5179' }), { db: database.db, logger: false });
  await api.listen({ host: '127.0.0.1', port: 3151 });
});
test.afterAll(async () => { await api?.close(); await database?.close(); });

async function enter(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('Логин').fill('synthetic-browser-owner');
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();
}
test('player-hero report preserves roles, missing metric coverage, explicit patch choice and empty/error states',async({page})=>{
  await enter(page);await page.goto('/players/'+catalogPlayerId);
  await expect(page.getByRole('heading',{name:'Герой и позиция',exact:true})).toBeVisible();
  await expect(page.getByText('Патч на дату среза не подтверждён.',{exact:false})).toBeVisible();
  await page.getByLabel('Герои: срез истории (UTC)',{exact:true}).fill('2024-01-03T00:00');
  await page.getByRole('button',{name:'Применить фильтры героев',exact:true}).click();
  const summary=page.getByRole('group',{name:'Показатели игрока на героях'});
  await expect(summary).toContainText('N = 2');await expect(summary).toContainText('KDA · N 1/2');
  const table=page.getByRole('table',{name:'Игрок, герой и подтверждённая позиция',exact:true});
  await expect(table.locator('tbody tr')).toHaveCount(2);await expect(table).toContainText('роль 1');await expect(table).toContainText('роль 2');
  await expect(table).toContainText('неизвестно · N 0/1');
  await page.locator('section').last().screenshot({path:'test-results/player-hero-desktop.png'});
  await page.setViewportSize({width:360,height:800});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('section').last().screenshot({path:'test-results/player-hero-mobile.png'});
  await page.getByLabel('Герои: подтверждённая позиция',{exact:true}).selectOption('2');
  await page.getByRole('button',{name:'Применить фильтры героев',exact:true}).click();
  await expect(summary).toContainText('N = 1');await expect(summary).toContainText('KDA · N 0/1');
  await expect(table.locator('tbody tr')).toHaveCount(1);await expect(table).toContainText('600 · N 1/1');
  await page.getByLabel('Герои: ID героя',{exact:true}).fill('999');
  await page.getByRole('button',{name:'Применить фильтры героев',exact:true}).click();
  await expect(summary).toContainText('N = 0');await expect(page.getByText('Нет подтверждённых профессиональных игр на герое за выбранный период.',{exact:false})).toBeVisible();
  await page.getByLabel('Герои: ID героя',{exact:true}).fill('1e3');
  await page.getByRole('button',{name:'Применить фильтры героев',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Некорректные фильтры');
  await page.getByLabel('Герои: ID героя',{exact:true}).fill('');await page.getByLabel('Патчи героя',{exact:true}).selectOption('all');
  await page.getByRole('button',{name:'Применить фильтры героев',exact:true}).click();
  await expect(summary).toContainText('N = 1');await expect(page.getByText('Применённые фильтры: все патчи',{exact:false})).toBeVisible();
});
