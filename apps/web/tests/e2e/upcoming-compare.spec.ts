import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedStrength} from '../../../../tests/helpers/strength';
import {scenarioInput} from '../../../../tests/helpers/scenario';
import {catalogPlayerId} from '../../../../tests/helpers/catalog';
import {scheduleToken,syntheticSchedule,syntheticRosters} from '../../../../tests/helpers/upcoming';
import {syntheticHistoryProvider} from '../../../../tests/helpers/history-refresh';
import {createHistoryQueue,registerHistoryWorker} from '../../../../packages/ingestion/dist/index.js';
import {sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string,boss:Awaited<ReturnType<typeof createHistoryQueue>>;
test.beforeAll(async()=>{
  database=await testDatabase();await seedStrength(database.db);password=randomBytes(24).toString('base64url');
  // Synthetic relative map clocks keep the default 90-day UI cohort observable; working DB is never touched.
  await sql`UPDATE matches SET started_at=clock_timestamp()-CASE WHEN id=8001 THEN interval '2 days' ELSE interval '1 day' END WHERE id IN (8001,8002)`.execute(database.db);
  await sql`UPDATE teams SET opendota_team_id=31 WHERE id=${scenarioInput().teamAId}`.execute(database.db);
  await sql`INSERT INTO players(id,nickname) VALUES(1200,'Синтетическая неизвестная личность')`.execute(database.db);
  await new AuthService(database.db).provision('synthetic-lineup-browser',password);
  api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',PANDASCORE_API_TOKEN:scheduleToken}),
    {db:database.db,logger:false,catalogueProvider:async()=>{throw Error('Synthetic catalogue unavailable');},pandascoreFetch:async url=>new Response(JSON.stringify(url.pathname.endsWith('/rosters')?syntheticRosters():syntheticSchedule()))});
  await api.listen({host:'127.0.0.1',port:3151});boss=await createHistoryQueue(database.url);
  await registerHistoryWorker(boss,database.db,()=>syntheticHistoryProvider());
});
test.afterAll(async()=>{await boss?.stop({graceful:true,timeout:10000});await api?.close();await database?.close();});
async function pick(page:Page,label:string,id:string){
  const field=page.getByRole('region',{name:label,exact:true});await field.getByRole('searchbox').fill(id);await field.getByRole('searchbox').press('Enter');
  await field.getByRole('button',{name:new RegExp(' · ID '+id+'$')}).click();
}
const confirm=(page:Page)=>page.getByLabel('Подтверждаю выбранных игроков и роли для одной карты',{exact:true});
const compare=(page:Page)=>page.getByRole('button',{name:'Сравнить выбранные пятёрки',exact:true});
const result=(page:Page)=>page.getByRole('region',{name:'Результат сравнения пятёрок',exact:true});
async function prepare(page:Page){
  await page.goto('/upcoming');await page.getByLabel('Логин').fill('synthetic-lineup-browser');await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('link',{name:'Предстоящие матчи →'}).click();
  await page.getByRole('button',{name:'Обновить расписание',exact:true}).click();await page.getByRole('button',{name:'Выбрать',exact:true}).click();
  await page.getByText('Выбрать игроков для анализа одной карты',{exact:true}).click();
  await expect(compare(page)).toBeDisabled();const q=scenarioInput();
  await pick(page,'Команда A в локальной базе',q.teamAId);await pick(page,'Команда B в локальной базе',q.teamBId);
  for(const [slot,line] of [['A',q.lineupA],['B',q.lineupB]] as const)for(const p of line)await pick(page,`${slot}: игрок роли ${p.rolePos}`,p.playerId!);
}

test('explicit confirmed comparison separates organization and exact-five history, preserves the form on refresh and handles observed zero',async({page})=>{
  const requests:unknown[]=[];page.on('request',r=>{if(r.url().endsWith('/teams/compare'))requests.push(r.postDataJSON());});
  const before=(await sql`SELECT id FROM scenarios`.execute(database.db)).rows.length;await prepare(page);
  for(const [slot,lineup] of [['A',scenarioInput().lineupA],['B',scenarioInput().lineupB]] as const)for(const p of lineup){
    const row=(await sql<{nickname:string}>`SELECT nickname FROM players WHERE id=${p.playerId}`.execute(database.db)).rows[0]!;
    await expect(page.getByRole('region',{name:`Автоопределение ролей ${slot}`,exact:true}).getByRole('listitem')
      .filter({hasText:`Выбранный игрок: ${row.nickname} · ID ${p.playerId}`})).toHaveCount(1);
  }
  expect(requests).toHaveLength(0);await expect(compare(page)).toBeDisabled();await confirm(page).check();await expect(compare(page)).toBeEnabled();
  expect(requests).toHaveLength(0);await compare(page).click();await expect(result(page)).toBeVisible();
  const q=scenarioInput();expect(requests[0]).toEqual({teamAId:q.teamAId,teamBId:q.teamBId,lineupA:q.lineupA,lineupB:q.lineupB});
  const a=result(page).getByRole('article',{name:'Пятёрка A',exact:true});
  await a.getByText('A · Организация и сыгранность',{exact:true}).click();
  await expect(a.getByRole('group',{name:'Организация A за период',exact:true})).toContainText('N = 2');
  await expect(a.getByRole('group',{name:'Точная пятёрка A в любых организациях',exact:true})).toContainText('N = 2');
  await expect(result(page)).toContainText('Период:');await expect(result(page)).toContainText('источник: нормализованные локальные pro-карты');
  await a.getByText('A · 10 пар в любых организациях',{exact:true}).click();
  await expect(a.getByRole('table',{name:'Пары пятёрки A',exact:true}).getByRole('row')).toHaveCount(11);
  await a.getByText('A · Личная история и роли',{exact:true}).click();await expect(a).toContainText(`ID ${q.lineupA[0]!.playerId} · выбранная роль 1`);
  await page.setViewportSize({width:1280,height:900});await result(page).screenshot({path:'test-results/upcoming-lineups-desktop.png'});
  await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await a.getByText('A · 10 пар в любых организациях',{exact:true}).click();await a.getByText('A · Личная история и роли',{exact:true}).click();
  await result(page).screenshot({path:'test-results/upcoming-lineups-mobile.png'});
  const card=page.getByRole('region',{name:'История организации A',exact:true});await card.getByText('Обновить историю организации A',{exact:true}).click();
  await card.getByRole('button',{name:'Загрузить последние pro-карты',exact:true}).click();
  await expect(card.getByRole('region',{name:'Обновление pro-истории',exact:true}).getByRole('status')).toContainText('Завершено',{timeout:15000});
  await expect.poll(()=>requests.length).toBe(2);await expect(result(page)).toBeVisible();await expect(confirm(page)).toBeChecked();
  await expect(page.getByRole('region',{name:'A: игрок роли 1',exact:true}).getByRole('status')).toContainText(q.lineupA[0]!.playerId!);
  await pick(page,'A: игрок роли 5',String(BigInt(catalogPlayerId)+10n));await expect(result(page)).toHaveCount(0);await expect(compare(page)).toBeDisabled();
  await confirm(page).check();await compare(page).click();await expect(result(page)).toBeVisible();
  await a.getByText('A · Организация и сыгранность',{exact:true}).click();
  await expect(a.getByRole('group',{name:'Организация A за период',exact:true})).toContainText('N = 2');
  const zero=a.getByRole('group',{name:'Точная пятёрка A в любых организациях',exact:true});await expect(zero).toContainText('N = 0');await expect(zero).toContainText('неизвестно');
  expect((await sql`SELECT id FROM scenarios`.execute(database.db)).rows).toHaveLength(before);
});

test('edits and unconfirmation discard pending results; retry and unavailable remain explicit without saving a scenario',async({page})=>{
  await prepare(page);await confirm(page).check();let release:()=>void=()=>undefined;const gate=new Promise<void>(r=>{release=r;});
  await page.route('**/api/v1/teams/compare',async route=>{const response=await route.fetch();await gate;await route.fulfill({response}).catch(()=>undefined);});
  await compare(page).click();await expect(page.getByText('Сравниваем подтверждённые пятёрки…',{exact:true})).toBeVisible();
  await page.getByLabel('A: замена роли 1',{exact:false}).check();await expect(confirm(page)).not.toBeChecked();release();
  await expect(result(page)).toHaveCount(0);await page.unroute('**/api/v1/teams/compare');await confirm(page).check();await compare(page).click();await expect(result(page)).toBeVisible();
  await confirm(page).uncheck();await expect(result(page)).toHaveCount(0);await expect(compare(page)).toBeDisabled();
  await confirm(page).check();await page.route('**/api/v1/teams/compare',route=>route.fulfill({status:503,json:{error:{code:'SYNTHETIC_COMPARE_FAILURE'}}}));
  await compare(page).click();const section=page.getByRole('region',{name:'Сравнение подтверждённых пятёрок',exact:true});await expect(section.getByRole('alert')).toBeVisible();await expect(result(page)).toHaveCount(0);
  await page.unroute('**/api/v1/teams/compare');await section.getByRole('button',{name:'Повторить сравнение пятёрок',exact:true}).click();await expect(result(page)).toBeVisible();
  await page.route('**/api/v1/teams/compare',route=>route.fulfill({json:{status:'unavailable',reason:'WINDOW_TOO_LARGE',maxCandidates:5000,message:'В окне больше 5000 карт. Уточните начальную дату.'}}));
  await compare(page).click();await expect(section.getByRole('status')).toContainText('В окне больше 5000 карт');await expect(result(page)).toHaveCount(0);
  await page.unroute('**/api/v1/teams/compare');await page.getByRole('region',{name:'Команда A в локальной базе',exact:true}).getByRole('button',{name:'Сбросить',exact:true}).click();
  await expect(section.getByRole('status')).toHaveCount(0);await expect(compare(page)).toBeDisabled();
});

test('a selected canonical record without verified identity keeps exact-five unknown and never invents zero history',async({page})=>{
  await prepare(page);await pick(page,'A: игрок роли 1','1200');await confirm(page).check();await compare(page).click();await expect(result(page)).toBeVisible();
  const a=result(page).getByRole('article',{name:'Пятёрка A',exact:true}),exact=a.getByRole('group',{name:'Точная пятёрка A в любых организациях',exact:true});
  await a.getByText('A · Организация и сыгранность',{exact:true}).click();
  await expect(exact).toContainText('N = неизвестно');await expect(a).toContainText('Исторические личности подтверждены для 4/5 игроков');
  await expect(a.getByRole('group',{name:'Организация A за период',exact:true})).toContainText('N = 2');
});
