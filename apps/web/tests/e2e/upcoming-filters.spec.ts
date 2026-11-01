import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedCompare} from '../../../../tests/helpers/compare';
import {scenarioInput} from '../../../../tests/helpers/scenario';
import {scheduleToken,syntheticSchedule,syntheticRosters} from '../../../../tests/helpers/upcoming';
import {syntheticHistoryProvider} from '../../../../tests/helpers/history-refresh';
import {createHistoryQueue,registerHistoryWorker} from '../../../../packages/ingestion/dist/index.js';
import {sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string,boss:Awaited<ReturnType<typeof createHistoryQueue>>;
const leagueId='9007199254741999';
test.beforeAll(async()=>{
  database=await testDatabase();await seedCompare(database.db);password=randomBytes(24).toString('base64url');
  await sql`INSERT INTO leagues(id,name) VALUES(${leagueId},'Synthetic filter league')`.execute(database.db);
  await sql`UPDATE matches SET league_id=${leagueId} WHERE id=8001`.execute(database.db);
  await sql`UPDATE teams SET opendota_team_id=31 WHERE id=${scenarioInput().teamAId}`.execute(database.db);
  await new AuthService(database.db).provision('synthetic-filter-browser',password);
  api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',PANDASCORE_API_TOKEN:scheduleToken}),
    {db:database.db,logger:false,pandascoreFetch:async url=>new Response(JSON.stringify(url.pathname.endsWith('/rosters')?syntheticRosters():syntheticSchedule()))});
  await api.listen({host:'127.0.0.1',port:3151});boss=await createHistoryQueue(database.url);
  await registerHistoryWorker(boss,database.db,()=>syntheticHistoryProvider());
});
test.afterAll(async()=>{await boss?.stop({graceful:true,timeout:10000});await api?.close();await database?.close();});
const section=(page:Page)=>page.getByRole('region',{name:'Сравнение подтверждённых пятёрок',exact:true});
const result=(page:Page)=>page.getByRole('region',{name:'Результат сравнения пятёрок',exact:true});
const compare=(page:Page)=>page.getByRole('button',{name:'Сравнить выбранные пятёрки',exact:true});
const field=(page:Page,label:string)=>page.getByLabel('Пятёрки: '+label,{exact:true});
const confirmation=(page:Page)=>page.getByLabel('Подтверждаю выбранных игроков и роли для одной карты',{exact:true});
async function prepare(page:Page){
  await page.goto('/upcoming');await page.getByLabel('Логин').fill('synthetic-filter-browser');await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('link',{name:'Предстоящие матчи →'}).click();
  await page.getByRole('button',{name:'Обновить расписание',exact:true}).click();await page.getByRole('button',{name:'Выбрать',exact:true}).click();
  await page.getByText('Выбрать игроков для анализа одной карты',{exact:true}).click();const q=scenarioInput();
  const pick=async(label:string,id:string)=>{const item=page.getByRole('region',{name:label,exact:true});await item.getByRole('searchbox').fill(id);
    await item.getByRole('searchbox').press('Enter');await item.getByRole('button',{name:new RegExp(' · ID '+id+'$')}).click();};
  await pick('Команда A в локальной базе',q.teamAId);await pick('Команда B в локальной базе',q.teamBId);
  for(const [slot,line] of [['A',q.lineupA],['B',q.lineupB]] as const)for(const p of line)await pick(`${slot}: игрок роли ${p.rolePos}`,p.playerId!);
  await confirmation(page).check();
}
async function window2024(page:Page){await field(page,'начало UTC').fill('2024-01-01T00:00');await field(page,'срез UTC').fill('2024-01-03T00:00');}
const exactA=(page:Page)=>result(page).getByRole('group',{name:'Точная пятёрка A в любых организациях',exact:true});

test('UTC window and bigint patch/league filters preserve confirmed lineups, show effective cohorts and reset explicitly without saving',async({page})=>{
  const requests:unknown[]=[];page.on('request',r=>{if(r.url().endsWith('/teams/compare'))requests.push(r.postDataJSON());});
  await prepare(page);await window2024(page);expect(requests).toHaveLength(0);await compare(page).click();await expect(exactA(page)).toContainText('N = 2');
  await field(page,'ID патча').fill('1');await expect(result(page)).toHaveCount(0);await expect(confirmation(page)).toBeChecked();expect(requests).toHaveLength(1);
  await field(page,'ID лиги').fill(leagueId);await field(page,'ID лиги').press('Enter');await expect(exactA(page)).toContainText('N = 1');
  const q=scenarioInput();expect(requests[1]).toEqual({teamAId:q.teamAId,teamBId:q.teamBId,lineupA:q.lineupA,lineupB:q.lineupB,
    fromAt:'2024-01-01T00:00:00.000Z',cutoffAt:'2024-01-03T00:00:00.000Z',patchId:'1',leagueId});
  await expect(result(page)).toContainText(`Применённые фильтры: патч 1, лига ${leagueId}`);
  await expect(page.getByRole('region',{name:'A: игрок роли 1',exact:true}).getByRole('status')).toContainText(q.lineupA[0]!.playerId!);
  await page.setViewportSize({width:1280,height:900});await section(page).screenshot({path:'test-results/upcoming-filters-desktop.png'});
  await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await section(page).screenshot({path:'test-results/upcoming-filters-mobile.png'});
  await field(page,'ID патча').fill('2');await compare(page).click();await expect(exactA(page)).toContainText('N = 0');await expect(exactA(page)).toContainText('неизвестно');
  await expect(field(page,'ID лиги')).toHaveValue(leagueId);await expect(field(page,'ID патча')).toHaveValue('2');expect(requests).toHaveLength(3);
  await page.getByRole('button',{name:'Сбросить фильтры пятёрок',exact:true}).click();await expect(result(page)).toHaveCount(0);await expect(confirmation(page)).toBeChecked();
  for(const label of ['начало UTC','срез UTC','ID патча','ID лиги'])await expect(field(page,label)).toHaveValue('');
  expect(requests).toHaveLength(3);await compare(page).click();await expect(exactA(page)).toContainText('N = 0');
  expect(requests[3]).toEqual({teamAId:q.teamAId,teamBId:q.teamBId,lineupA:q.lineupA,lineupB:q.lineupB});
  await page.getByRole('button',{name:'Сбросить фильтры пятёрок',exact:true}).click();await expect(result(page)).toHaveCount(0);expect(requests).toHaveLength(4);
  expect((await sql`SELECT id FROM scenarios`.execute(database.db)).rows).toHaveLength(0);
});

test('invalid filters make no request; filter edits discard delayed/overflow results and history refresh retains explicit filters',async({page})=>{
  const requests:unknown[]=[];page.on('request',r=>{if(r.url().endsWith('/teams/compare'))requests.push(r.postDataJSON());});
  await prepare(page);await window2024(page);await field(page,'начало UTC').fill('2024-01-03T00:00');await compare(page).click();await expect(section(page).getByRole('alert')).toContainText('Проверьте даты UTC');
  await field(page,'начало UTC').fill('2024-01-01T00:00');await field(page,'срез UTC').fill('2099-01-01T00:00');await compare(page).click();await expect(section(page).getByRole('alert')).toBeVisible();
  await field(page,'срез UTC').fill('2024-01-03T00:00');
  for(const bad of ['-1','abc','9223372036854775808']){await field(page,'ID лиги').fill(bad);await compare(page).click();await expect(section(page).getByRole('alert')).toBeVisible();}
  expect(requests).toHaveLength(0);await expect(confirmation(page)).toBeChecked();await field(page,'ID лиги').fill(leagueId);await field(page,'ID патча').fill('1');
  let release:()=>void=()=>undefined;const gate=new Promise<void>(r=>{release=r;});
  await page.route('**/api/v1/teams/compare',async route=>{const response=await route.fetch();await gate;await route.fulfill({response}).catch(()=>undefined);});
  await compare(page).click();await expect(section(page).getByRole('status')).toContainText('Сравниваем');await field(page,'начало UTC').fill('2024-01-02T00:00');release();
  await expect(result(page)).toHaveCount(0);await expect(confirmation(page)).toBeChecked();await page.unroute('**/api/v1/teams/compare');expect(requests).toHaveLength(1);
  await field(page,'начало UTC').fill('2024-01-01T00:00');await compare(page).click();await expect(exactA(page)).toContainText('N = 1');
  const card=page.getByRole('region',{name:'История организации A',exact:true});await card.getByText('Обновить историю организации A',{exact:true}).click();
  await card.getByRole('button',{name:'Загрузить последние pro-карты',exact:true}).click();
  await expect(card.getByRole('region',{name:'Обновление pro-истории',exact:true}).getByRole('status')).toContainText('Завершено',{timeout:15000});
  await expect.poll(()=>requests.length).toBe(3);expect(requests[2]).toEqual(requests[1]);await expect(exactA(page)).toContainText('N = 1');await expect(confirmation(page)).toBeChecked();
  await page.route('**/api/v1/teams/compare',route=>route.fulfill({json:{status:'unavailable',reason:'WINDOW_TOO_LARGE',maxCandidates:5000,message:'В периоде больше 5000 карт.'}}));
  await compare(page).click();await expect(section(page).getByRole('status')).toContainText('Окно не расширяется автоматически');await expect(result(page)).toHaveCount(0);
  await expect(field(page,'начало UTC')).toHaveValue('2024-01-01T00:00');await expect(field(page,'ID лиги')).toHaveValue(leagueId);
  await field(page,'начало UTC').fill('2024-01-02T00:00');await expect(section(page).getByRole('status')).toHaveCount(0);expect(requests).toHaveLength(4);
  await page.unroute('**/api/v1/teams/compare');await compare(page).click();await expect(exactA(page)).toContainText('N = 0');await expect(confirmation(page)).toBeChecked();
  expect((await sql`SELECT id FROM scenarios`.execute(database.db)).rows).toHaveLength(0);
});
