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
  await new AuthService(database.db).provision('synthetic-upcoming-browser',password);
  api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',PANDASCORE_API_TOKEN:scheduleToken}),
    {db:database.db,logger:false,pandascoreFetch:async url=>new Response(JSON.stringify(failed?{}:url.pathname.endsWith('/rosters')?syntheticRosters():syntheticSchedule()),{status:failed?403:200})});
  await api.listen({host:'127.0.0.1',port:3151});
});
test.afterAll(async()=>{await api?.close();await database?.close();});
async function signIn(page:import('@playwright/test').Page){
  await page.goto('/upcoming');await expect(page).toHaveURL(/login/);await page.getByLabel('Логин').fill('synthetic-upcoming-browser');await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('link',{name:'Предстоящие матчи →'}).click();
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
  await page.getByLabel('Команда A в локальной базе · ID',{exact:true}).fill(q.teamAId);await page.getByLabel('Команда B в локальной базе · ID',{exact:true}).fill(q.teamBId);
  for(const [slot,line] of [['A',q.lineupA],['B',q.lineupB]] as const)for(const p of line)
    await page.getByLabel(`${slot}: игрок роли ${p.rolePos} · ID из справочника`,{exact:true}).fill(p.playerId!);
  await expect(page.getByRole('button',{name:'Создать ручной сценарий',exact:true})).toBeDisabled();
  await page.getByLabel('Подтверждаю выбранных игроков и роли для одной карты',{exact:true}).check();
  await page.getByRole('button',{name:'Создать ручной сценарий',exact:true}).click();await expect(page.getByRole('heading',{name:'Сценарий · редакция 1',exact:true})).toBeVisible();
  const saved=(await sql<{input_snapshot:typeof q}>`SELECT input_snapshot FROM scenario_input_snapshots`.execute(database.db)).rows[0]!.input_snapshot;
  expect(saved.teamAId).toBe(q.teamAId);expect(saved.lineupA.map(p=>p.playerId)).toEqual(q.lineupA.map(p=>p.playerId));expect(saved.context.seriesId).toBeNull();
  expect(saved.context.radiantSlot).toBeNull();expect(saved.expectedLineupA).toBeNull();
});
test('source failure keeps saved schedule visible with freshness warning',async({page})=>{
  failed=true;await sql`UPDATE upcoming_source_cache SET expires_at=clock_timestamp()-interval '1 second' WHERE payload IS NOT NULL`.execute(database.db);
  await sql`UPDATE pandascore_request_quota SET next_request_at='-infinity'`.execute(database.db);
  await signIn(page);await page.getByRole('button',{name:'Обновить расписание',exact:true}).click();
  await expect(page.getByText('Не удалось обновить источник. Сохранённые данные показаны ниже.',{exact:true})).toBeVisible();
  await expect(page.getByText('Синтетическая Alpha — Синтетическая Beta',{exact:true})).toBeVisible();
  await expect(page.getByText('Сохранённое расписание устарело.',{exact:false})).toBeVisible();
});
