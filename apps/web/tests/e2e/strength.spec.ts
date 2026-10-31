import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { testDatabase } from '../../../../tests/helpers/postgres';
import { buildApp } from '../../../api/src/app';
import { readConfig } from '../../../api/src/config';
import { AuthService } from '../../../api/src/modules/auth/service';
import type { FastifyInstance } from 'fastify';
import { catalogTeamId } from '../../../../tests/helpers/catalog';
import { seedStrength } from '../../../../tests/helpers/strength';

let database: Awaited<ReturnType<typeof testDatabase>>;
let api: FastifyInstance;
let password: string;
test.beforeAll(async () => {
  database = await testDatabase();
  await seedStrength(database.db);
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
test('chronological Elo separates raw organization WR, historic opponent strength, warmup and missing evidence',async({page})=>{
  await enter(page);await page.goto('/teams/'+catalogTeamId);
  await expect(page.getByRole('heading',{name:'Elo и сила соперников',exact:true})).toBeVisible();
  await page.getByLabel('Elo: срез (UTC)',{exact:true}).fill('2024-01-03T00:00');
  await page.getByRole('button',{name:'Применить период Elo',exact:true}).click();
  const summary=page.getByRole('group',{name:'Рейтинг и сила соперников'});
  await expect(summary).toContainText('N = 2');await expect(summary.locator('strong').nth(1)).toHaveText('2');
  const table=page.getByRole('table',{name:'История Elo организации',exact:true});await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(table.locator('tbody tr').first().locator('td').nth(1)).toHaveText(/1\s?516\s*\/\s*1\s?484/);await expect(table).toContainText('Состав восстановлен по завершённой карте');
  await page.locator('section').last().screenshot({path:'test-results/strength-desktop.png'});
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('section').last().screenshot({path:'test-results/strength-mobile.png'});
  await page.getByLabel('Elo: начало отчёта (UTC)',{exact:true}).fill('2024-01-02T00:00');
  await page.getByRole('button',{name:'Применить период Elo',exact:true}).click();await expect(summary).toContainText('N = 1');
  await expect(table.locator('tbody tr')).toHaveCount(1);await expect(table.locator('tbody tr').first().locator('td').nth(1)).toHaveText(/1\s?516\s*\/\s*1\s?484/);
  await page.getByLabel('Elo: начало отчёта (UTC)',{exact:true}).fill('2025-01-01T00:00');
  await page.getByRole('button',{name:'Применить период Elo',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Некорректные фильтры');
  await page.getByLabel('Elo: срез (UTC)',{exact:true}).fill('2025-02-01T00:00');
  await page.getByRole('button',{name:'Применить период Elo',exact:true}).click();await expect(summary).toContainText('N = 0');
  await expect(page.getByText('Недостаточно исторических доказательств для рейтинга в этой выборке.',{exact:false})).toBeVisible();
});
