import {test,expect} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedStrength} from '../../../../tests/helpers/strength';
import {scenarioInput} from '../../../../tests/helpers/scenario';
import {scheduleToken,syntheticSchedule,syntheticRosters} from '../../../../tests/helpers/upcoming';
import {sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';import {readConfig} from '../../../api/src/config';import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string,failed=false;
test.beforeAll(async()=>{
  database=await testDatabase();await seedStrength(database.db);password=randomBytes(24).toString('base64url');
  const q=scenarioInput();await sql`UPDATE players SET nickname='Синтетический тёзка' WHERE id IN (${q.lineupA[0]!.playerId}::bigint,${q.lineupA[1]!.playerId}::bigint)`.execute(database.db);
  await new AuthService(database.db).provision('synthetic-upcoming-browser',password);
  api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',PANDASCORE_API_TOKEN:scheduleToken}),
    {db:database.db,logger:false,pandascoreFetch:async url=>new Response(JSON.stringify(failed?{}:url.pathname.endsWith('/rosters')?syntheticRosters():syntheticSchedule()),{status:failed?403:200})});
  await api.listen({host:'127.0.0.1',port:3151});
});
test.afterAll(async()=>{await api?.close();await database?.close();});
test.beforeEach(()=>{failed=false;});
async function signIn(page:import('@playwright/test').Page){
  await page.goto('/upcoming');await expect(page).toHaveURL(/login/);await page.getByLabel('Логин').fill('synthetic-upcoming-browser');await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('link',{name:'Предстоящие матчи →'}).click();
}
async function pick(page:import('@playwright/test').Page,label:string,id:string){
  const field=page.getByRole('region',{name:label,exact:true});await field.getByRole('searchbox',{name:label,exact:true}).fill(id);
  await field.getByRole('searchbox').press('Enter');await field.getByRole('button',{name:new RegExp(' · ID '+id+'$')}).click();
  await expect(field.getByRole('status')).toContainText('ID '+id);
}
test('owner loads schedule and all expected players, manually chooses canonical scenario; mobile layout',async({page})=>{
  await signIn(page);await expect(page.getByText('Данные ещё не загружены.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Обновить расписание',exact:true}).click();await expect(page.getByText('Синтетическая Alpha — Синтетическая Beta',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Выбрать',exact:true}).click();await page.getByRole('button',{name:'Обновить составы',exact:true}).click();
  const rosters=page.getByRole('region',{name:'Ожидаемые составы'});await expect(rosters.getByText('В заявке: 6 игроков',{exact:true})).toBeVisible();
  await expect(rosters.getByText('Синтетический игрок 1-6',{exact:true})).toBeVisible();await expect(rosters.getByText('Нужно вручную уточнить пятёрку.',{exact:true})).toBeVisible();
  await expect(rosters.getByText('Связь этих игроков с локальной историей ещё не подтверждена.',{exact:false})).toBeVisible();
  await page.screenshot({path:'test-results/upcoming-desktop.png',fullPage:true});await page.setViewportSize({width:360,height:800});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/upcoming-mobile.png',fullPage:true});
  await rosters.getByText('Выбрать игроков для анализа одной карты',{exact:true}).click();const q=scenarioInput();
  await pick(page,'Команда A в локальной базе',q.teamAId);await pick(page,'Команда B в локальной базе',q.teamBId);
  for(const [slot,line] of [['A',q.lineupA],['B',q.lineupB]] as const)for(const p of line)
    await pick(page,`${slot}: игрок роли ${p.rolePos}`,p.playerId!);
  await expect(page.getByRole('button',{name:'Создать ручной сценарий',exact:true})).toBeDisabled();
  await page.getByLabel('Подтверждаю выбранных игроков и роли для одной карты',{exact:true}).check();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/upcoming-picker-mobile.png',fullPage:true});await page.setViewportSize({width:1280,height:900});
  await page.screenshot({path:'test-results/upcoming-picker-desktop.png',fullPage:true});await page.setViewportSize({width:360,height:800});
  await page.getByRole('button',{name:'Создать ручной сценарий',exact:true}).click();await expect(page.getByRole('heading',{name:'Сценарий · редакция 1',exact:true})).toBeVisible();
  const saved=(await sql<{input_snapshot:typeof q}>`SELECT input_snapshot FROM scenario_input_snapshots`.execute(database.db)).rows[0]!.input_snapshot;
  expect(saved.teamAId).toBe(q.teamAId);expect(saved.lineupA.map(p=>p.playerId)).toEqual(q.lineupA.map(p=>p.playerId));expect(saved.context.seriesId).toBeNull();
  expect(saved.context.radiantSlot).toBeNull();expect(saved.expectedLineupA).toBeNull();
});
test('catalogue search requires explicit choice, distinguishes same-name records, blocks duplicates and recovers errors',async({page})=>{
  const beforeCount=(await sql`SELECT id FROM scenarios`.execute(database.db)).rows.length;
  await signIn(page);await page.getByRole('button',{name:'Обновить расписание',exact:true}).click();await page.getByRole('button',{name:'Выбрать',exact:true}).click();
  await page.getByText('Выбрать игроков для анализа одной карты',{exact:true}).click();const q=scenarioInput(),id=q.lineupA[0]!.playerId!;
  const field=page.getByRole('region',{name:'A: игрок роли 1',exact:true}),input=field.getByRole('searchbox');
  await input.fill('Синтетический тёзка');await input.press('Enter');await expect(field.getByRole('button',{name:/^Выбрать Синтетический тёзка/})).toHaveCount(2);
  await expect(field.getByText(/^Выбрано:/)).toHaveCount(0);await field.getByRole('button',{name:new RegExp(' · ID '+id+'$')}).click();
  const confirm=page.getByLabel('Подтверждаю выбранных игроков и роли для одной карты',{exact:true});await confirm.check();
  await input.fill('такого-синтетического-игрока-нет');await expect(confirm).not.toBeChecked();await input.press('Enter');
  await expect(field.getByText('В локальном справочнике нет подходящей записи.',{exact:false})).toBeVisible();
  await expect(field.getByText(/^Выбрано:/)).toHaveCount(0);
  await page.route('**/api/v1/players?*',route=>route.fulfill({status:503,json:{error:{code:'SYNTHETIC_FAILURE'}}}));
  await input.fill(id);await input.press('Enter');await expect(field.getByRole('alert')).toBeVisible();
  await page.unroute('**/api/v1/players?*');await field.getByRole('button',{name:'Повторить поиск',exact:true}).click();
  await field.getByRole('button',{name:new RegExp(' · ID '+id+'$')}).click();
  const other=page.getByRole('region',{name:'A: игрок роли 2',exact:true});await other.getByRole('searchbox').fill(id);await other.getByRole('searchbox').press('Enter');
  await expect(other.getByRole('button',{name:new RegExp(' · ID '+id+'$')})).toBeDisabled();
  await expect(other.getByText('· Уже выбрано в составе',{exact:false})).toBeVisible();
  await pick(page,'A: игрок роли 2',q.lineupA[1]!.playerId!);
  await field.getByRole('button',{name:'Сбросить',exact:true}).click();await expect(input).toHaveValue('');
  await input.fill(id);await input.press('Enter');await input.press('Escape');await expect(field.getByRole('list')).toHaveCount(0);
  await expect(field.getByText(/^Выбрано:/)).toHaveCount(0);await expect(page.getByRole('button',{name:'Создать ручной сценарий'})).toBeDisabled();
  expect((await sql`SELECT id FROM scenarios`.execute(database.db)).rows).toHaveLength(beforeCount);
});
test('source failure keeps saved schedule visible with freshness warning',async({page})=>{
  await signIn(page);await page.getByRole('button',{name:'Обновить расписание',exact:true}).click();
  failed=true;await sql`UPDATE upcoming_source_cache SET expires_at=clock_timestamp()-interval '1 second' WHERE payload IS NOT NULL`.execute(database.db);
  await sql`UPDATE pandascore_request_quota SET next_request_at='-infinity'`.execute(database.db);
  await page.getByRole('button',{name:'Обновить расписание',exact:true}).click();
  await expect(page.getByText('Не удалось обновить источник. Сохранённые данные показаны ниже.',{exact:true})).toBeVisible();
  await expect(page.getByText('Синтетическая Alpha — Синтетическая Beta',{exact:true})).toBeVisible();
  await expect(page.getByText('Сохранённое расписание устарело.',{exact:false})).toBeVisible();
});
