import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { testDatabase } from '../../../../tests/helpers/postgres';
import { buildApp } from '../../../api/src/app';
import { readConfig } from '../../../api/src/config';
import { AuthService } from '../../../api/src/modules/auth/service';
import type { FastifyInstance } from 'fastify';
import { catalogPlayerId } from '../../../../tests/helpers/catalog';
import { seedSamples } from '../../../../tests/helpers/sample';

let database: Awaited<ReturnType<typeof testDatabase>>;
let api: FastifyInstance;
let password: string;
test.beforeAll(async () => {
  database = await testDatabase();
  await seedSamples(database.db);
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
test('sample size, raw frequency and experimental prior stay distinct including zero-observation cold start',async({page})=>{
  await enter(page);await page.goto('/players/'+catalogPlayerId);
  await page.getByLabel('Герои: начало периода (UTC)',{exact:true}).fill('2024-01-01T00:00');
  await page.getByLabel('Герои: срез истории (UTC)',{exact:true}).fill('2024-01-03T00:00');
  await page.getByLabel('Герои: ID героя',{exact:true}).fill('1');await page.getByLabel('Герои: подтверждённая позиция',{exact:true}).selectOption('1');
  await page.getByRole('button',{name:'Применить фильтры героев',exact:true}).click();
  const panel=page.locator('section').last(),summary=page.getByRole('group',{name:'Показатели игрока на героях'});
  await expect(summary).toContainText('N = 1');await expect(summary).toContainText('100');
  await expect(panel.getByRole('group',{name:'Сглаженная историческая оценка',exact:true})).toContainText('50');
  await expect(panel.getByText('Исходная частота',{exact:false}).first()).toContainText('объём prior 3 карт');
  await expect(panel.getByText('Менее 10 карт.',{exact:false})).toBeVisible();await expect(panel.getByText('N_eff не рассчитывается.',{exact:false})).toBeVisible();
  await panel.screenshot({path:'test-results/sample-desktop.png'});
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await panel.screenshot({path:'test-results/sample-mobile.png'});
  await page.getByLabel('Герои: начало периода (UTC)',{exact:true}).fill('2024-01-03T00:00');
  await page.getByLabel('Герои: срез истории (UTC)',{exact:true}).fill('2024-01-04T00:00');
  await page.getByRole('button',{name:'Применить фильтры героев',exact:true}).click();
  await expect(summary).toContainText('N = 0');await expect(summary).toContainText('неизвестно');
  await expect(panel.getByText('только исходная оценка пула, новых наблюдений нет',{exact:false})).toBeVisible();
  await expect(panel.getByText('Холодный старт по данным.',{exact:false})).toBeVisible();
  await page.getByLabel('Герои: ID героя',{exact:true}).fill('999');await page.getByRole('button',{name:'Применить фильтры героев',exact:true}).click();
  await expect(panel.getByText('Сглаживание недоступно.',{exact:false})).toBeVisible();
});
