import {syntheticPlayerHistory} from '../../../../tests/helpers/player-history';
import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedStrength} from '../../../../tests/helpers/strength';
import {scenarioInput} from '../../../../tests/helpers/scenario';
import {catalogPlayerId} from '../../../../tests/helpers/catalog';
import {scheduleToken,syntheticSchedule,syntheticRosters} from '../../../../tests/helpers/upcoming';
import {sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string;
const sourceCalls:string[]=[];let release:()=>void=()=>undefined;const gate=new Promise<void>(r=>release=r);
test.beforeAll(async()=>{
  database=await testDatabase();await seedStrength(database.db);password=randomBytes(24).toString('base64url');
  // Synthetic relative map clocks keep the default 90-day UI cohort observable; working DB is never touched.
  await sql`UPDATE matches SET started_at=clock_timestamp()-CASE WHEN id=8001 THEN interval '2 days' ELSE interval '1 day' END WHERE id IN (8001,8002)`.execute(database.db);
  await sql`UPDATE teams SET opendota_team_id=31 WHERE id=${scenarioInput().teamAId}`.execute(database.db);
  await sql`INSERT INTO players(id,nickname) VALUES(1200,'Синтетическая неизвестная личность')`.execute(database.db);
  await new AuthService(database.db).provision('synthetic-lineup-browser',password);
  api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',PANDASCORE_API_TOKEN:scheduleToken}),
    {db:database.db,logger:false,playerHistoryProvider:()=>syntheticPlayerHistory({gate,onCall:name=>sourceCalls.push(name)}),catalogueProvider:async()=>{throw Error('Synthetic catalogue unavailable');},pandascoreFetch:async url=>new Response(JSON.stringify(url.pathname.endsWith('/rosters')?syntheticRosters():syntheticSchedule()))});
  await api.listen({host:'127.0.0.1',port:3151});
});
test.afterAll(async()=>{release();await api?.close();await database?.close();});
async function pick(page:Page,label:string,id:string){
  const field=page.getByRole('region',{name:label,exact:true});if(await field.getByRole('button',{name:'Заменить',exact:true}).count())await field.getByRole('button',{name:'Заменить',exact:true}).click();await field.getByRole('searchbox').fill(id);await field.getByRole('searchbox').press('Enter');
  await field.locator(`button[data-catalog-id="${id}"]`).click();
}
const confirm=(page:Page)=>page.getByRole('button',{name:'Подтвердить пятёрки и роли',exact:true});
const compare=(page:Page)=>page.getByRole('button',{name:'Сравнить выбранные пятёрки',exact:true});
const result=(page:Page)=>page.getByRole('region',{name:'Результат сравнения пятёрок',exact:true});
async function prepare(page:Page){
  await page.goto('/upcoming');await page.getByLabel('Логин').fill('synthetic-lineup-browser');await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('link',{name:'Предстоящие матчи →'}).click();
  await page.getByRole('button',{name:'Обновить расписание',exact:true}).click();await page.getByRole('button',{name:'Выбрать',exact:true}).click();
  await page.getByText('Выбрать игроков для анализа одной карты',{exact:true}).click();
  await expect(compare(page)).toBeDisabled();const q=scenarioInput();
  await pick(page,'Команда A в локальной базе',q.teamAId);await pick(page,'Команда B в локальной базе',q.teamBId);
  for(const [slot,line] of [['A',q.lineupA],['B',q.lineupB]] as const)for(const p of line)await pick(page,`${slot}: игрок ${p.rolePos}`,p.playerId!);
}

test('comparison prepares missing personal history once, keeps local report and refreshes without changing roles or filters',async({page})=>{
 test.setTimeout(60000);let posts=0,comparisons=0;
 page.on('request',r=>{if(r.url().endsWith('/players/comparison-history')&&r.method()==='POST')posts++;if(r.url().endsWith('/teams/compare'))comparisons++;});
 await prepare(page);await confirm(page).click();expect(posts).toBe(0);expect(sourceCalls).toHaveLength(0);
 await compare(page).click();await expect(result(page)).toBeVisible();const panel=page.getByRole('region',{name:'Подготовка истории для сравнения',exact:true});
 await expect.poll(()=>sourceCalls.filter(n=>n==='discover').length).toBeGreaterThan(0);await expect(panel).toContainText('История OpenDota');
 const initialRuns=(await sql`SELECT id FROM player_history_runs`.execute(database.db)).rows;
 await compare(page).click();await expect(result(page)).toBeVisible();expect(posts).toBe(1);expect((await sql`SELECT id FROM player_history_runs`.execute(database.db)).rows).toEqual(initialRuns);
 release();await expect.poll(async()=>{const rows=(await sql<{status:string}>`SELECT status FROM player_history_runs`.execute(database.db)).rows;return rows.length===2&&rows.every(r=>r.status==='completed');},{timeout:20000}).toBe(true);
 await expect.poll(()=>comparisons,{timeout:15000}).toBeGreaterThan(2);await expect(result(page)).toBeVisible();
 await expect(confirm(page)).toHaveAttribute('aria-pressed','true');await expect(page.getByLabel('Период сравнения',{exact:true})).toHaveValue('90');
 await expect(result(page).getByRole('table',{name:'Личная статистика B',exact:true})).toContainText('4');
 const calls=sourceCalls.length;await compare(page).click();await expect(panel).toContainText('Завершено');expect(sourceCalls).toHaveLength(calls);expect((await sql`SELECT id FROM player_history_runs`.execute(database.db)).rows).toHaveLength(2);
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await panel.screenshot({path:'.tools/auto-comparison-history-20261112/mobile.png'});
 await page.getByText('Точные даты, патч и лига',{exact:true}).click();await page.getByLabel('Пятёрки: срез UTC',{exact:true}).fill('2023-03-01T00:00');const before=posts;
 await compare(page).click();await expect(result(page)).toBeVisible();await expect(panel).toHaveCount(0);expect(posts).toBe(before);expect(sourceCalls).toHaveLength(calls);
});
test('a late preparation response cannot restore a comparison after lineup edits',async({page})=>{
 await prepare(page);await confirm(page).click();let unblock:()=>void=()=>undefined;const paused=new Promise<void>(r=>unblock=r);
 await page.route('**/api/v1/players/comparison-history',async route=>{const response=await route.fetch();await paused;await route.fulfill({response}).catch(()=>undefined);});
 await compare(page).click();await expect(result(page)).toBeVisible();await page.getByLabel('A: замена игрока 1',{exact:false}).check();unblock();
 await expect(result(page)).toHaveCount(0);await expect(page.getByRole('region',{name:'Подготовка истории для сравнения',exact:true})).toHaveCount(0);await expect(compare(page)).toBeDisabled();
});
