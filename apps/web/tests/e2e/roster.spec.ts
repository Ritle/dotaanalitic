import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { testDatabase } from '../../../../tests/helpers/postgres';
import { buildApp } from '../../../api/src/app';
import { readConfig } from '../../../api/src/config';
import { AuthService } from '../../../api/src/modules/auth/service';
import type { FastifyInstance } from 'fastify';
import { catalogTeamId,catalogPlayerId } from '../../../../tests/helpers/catalog';
import { seedProMaps } from '../../../../tests/helpers/pro-maps';

let database: Awaited<ReturnType<typeof testDatabase>>;
let api: FastifyInstance;
let password: string;
test.beforeAll(async () => {
  database = await testDatabase();
  await seedProMaps(database.db);
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
test('roster replacement recomputes ten pairs, role swaps preserve identity and partial inputs stay unknown',async({page})=>{
  await enter(page);await page.goto('/teams/'+catalogTeamId);
  for(let i=0;i<5;i++)await page.getByLabel(`Выбранный игрок роли ${i+1}`,{exact:true}).fill(String(BigInt(catalogPlayerId)+BigInt(i)));
  await page.getByRole('button',{name:'Рассчитать сыгранность',exact:true}).click();
  const summary=page.getByRole('group',{name:'Сыгранность выбранной пятёрки'});
  await expect(summary.locator('strong').first()).toHaveText('2');
  await expect(page.getByRole('table',{name:'Исторические пары',exact:true}).locator('tbody tr')).toHaveCount(10);
  await page.getByLabel('Сравнить с базовой пятёркой').check();
  for(let i=0;i<5;i++)await page.getByLabel(`Базовый игрок роли ${i+1}`,{exact:true}).fill(String(BigInt(catalogPlayerId)+BigInt(i)));
  await page.getByLabel('Выбранный игрок роли 5',{exact:true}).fill(String(BigInt(catalogPlayerId)+5n));
  await expect(summary).toHaveCount(0); // An edited lineup cannot display the previous result as current.
  await page.getByLabel('Stand-in роли 5',{exact:true}).check();
  await page.getByRole('button',{name:'Рассчитать сыгранность',exact:true}).click();
  await expect(summary.locator('strong').first()).toHaveText('0');
  await expect(page.getByRole('group',{name:'Сравнение составов'})).toContainText('сохранено 4 из 5 игроков и 6 из 10 пар');
  await page.locator('section').last().screenshot({path:'test-results/roster-desktop.png'});
  await page.setViewportSize({width:360,height:800});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('section').last().screenshot({path:'test-results/roster-mobile.png'});
  await page.getByLabel('Выбранный игрок роли 5',{exact:true}).fill(String(BigInt(catalogPlayerId)+4n));
  await page.getByLabel('Выбранный игрок роли 1',{exact:true}).fill(String(BigInt(catalogPlayerId)+1n));
  await page.getByLabel('Выбранный игрок роли 2',{exact:true}).fill(catalogPlayerId);
  await page.getByRole('button',{name:'Рассчитать сыгранность',exact:true}).click();
  await expect(summary.locator('strong').first()).toHaveText('2');
  await expect(page.getByRole('group',{name:'Сравнение составов'})).toContainText('Перестановок ролей: 2');
  await page.getByLabel('Выбранный игрок роли 1',{exact:true}).fill('');
  await page.getByRole('button',{name:'Рассчитать сыгранность',exact:true}).click();
  await expect(summary.locator('strong').first()).toHaveText('неизвестно');
  await expect(page.getByText('Статус замены неизвестен:',{exact:false})).toBeVisible();
  await page.getByLabel('Выбранный игрок роли 1',{exact:true}).fill(catalogPlayerId);
  await page.getByRole('button',{name:'Рассчитать сыгранность',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('пять разных ID');
});
