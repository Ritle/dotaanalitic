import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedStrength} from '../../../../tests/helpers/strength';
import {catalogTeamId} from '../../../../tests/helpers/catalog';
import {sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string;
const ids=Array.from({length:21},(_,i)=>String(9007199254742000n+BigInt(i)));
test.beforeAll(async()=>{
 database=await testDatabase();await seedStrength(database.db);password=randomBytes(24).toString('base64url');
 await new AuthService(database.db).provision('synthetic-history-strength-labels',password);
 for(let i=0;i<20;i++)await sql`INSERT INTO teams(id,opendota_team_id,name) VALUES(${ids[i]!},${18000+i},${i<2?'Synthetic Opponent Twin':i===2?'':'Synthetic Opponent '+i})`.execute(database.db);
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});await api.listen({host:'127.0.0.1',port:3151});
});
test.afterAll(async()=>{await api?.close();await database?.close();});
async function enter(page:Page){await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-history-strength-labels');await page.getByLabel('Пароль').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();}
const path=(q:Record<string,string>)=>'/api/v1/context-catalog?'+new URLSearchParams(q);

test('private team batches retain bigint identity, closed modes and read-only SQL; old single-ID/search contract is unchanged',async({page})=>{
 expect((await page.request.get(path({kind:'teams',ids:ids.slice(0,20).join(',')}))).status()).toBe(401);await enter(page);
 const before=(await sql`SELECT id::text,name,opendota_team_id::text FROM teams ORDER BY id`.execute(database.db)).rows;
 const response=await page.request.get(path({kind:'teams',ids:ids.slice(0,20).join(',')}));expect(response.status()).toBe(200);const body=await response.json();
 expect(body.items).toHaveLength(20);expect(body.hasMore).toBe(false);expect(body.items.filter((p:{name:string})=>p.name==='Synthetic Opponent Twin')).toHaveLength(2);
 expect(body.items).toContainEqual({id:ids[2],name:''});
 expect((await(await page.request.get(path({kind:'teams',ids:ids[20]!}))).json()).items).toEqual([]);
 expect((await(await page.request.get(path({kind:'teams',ids:'18000'}))).json()).items).toEqual([]);
 expect((await(await page.request.get(path({kind:'teams',ids:[ids[0]!,ids[0]!].join(',')}))).json()).items).toEqual([{id:ids[0],name:'Synthetic Opponent Twin'}]);
 expect((await(await page.request.get(path({kind:'teams',id:ids[0]!}))).json()).items).toEqual([{id:ids[0],name:'Synthetic Opponent Twin'}]);
 expect((await(await page.request.get(path({kind:'teams',query:'Synthetic Opponent Twin'}))).json()).items.map((p:{id:string})=>p.id)).toEqual(ids.slice(0,2));
 for(const q of [{kind:'teams',ids:ids.join(',')},{kind:'teams',ids:''},{kind:'teams',ids:'1,2',query:'x'},
  {kind:'teams',ids:'1,2',id:'1'},{kind:'teams',ids:'1,2',offset:'1'},{kind:'players',ids:'1,2'},{kind:'teams',ids:'9223372036854775808'}])expect((await page.request.get(path(q))).status()).toBe(400);
 expect((await sql`SELECT id::text,name,opendota_team_id::text FROM teams ORDER BY id`.execute(database.db)).rows).toEqual(before);
});

test('synthetic23-map display resolves21 opponents in two batches, keeps null/duplicates and preserves Elo through rename and partial failure',async({page})=>{
 await enter(page);let strengthReads=0,failLast=false;const names:string[][]=[];
 await page.route(`**/api/v1/teams/${catalogTeamId}/strength?*`,async route=>{
  strengthReads++;const response=await route.fetch(),body=await response.json();
  // Explicit synthetic display expansion only; these23 maps are never imported or rated in the database.
  if(body.maps?.length){const base=body.maps[0];body.maps=Array.from({length:23},(_,i)=>({...base,matchId:String(780000+i),opponentId:i===21?null:ids[i===22?0:i]}));
   body.summary={...body.summary,nRaw:23,wins:base.won?23:0,winRate:base.won?1:0,ratedMaps:base.rating?23:0,meanOpponentRatingBefore:base.rating?.opponentBefore??null,meanRatingChange:base.rating?.change??null};body.coverage.targetMapsBeforeLimit=23;}
  await route.fulfill({response,json:body});
 });
 await page.route('**/api/v1/context-catalog?*',route=>{
  const q=new URL(route.request().url()).searchParams;if(q.get('kind')==='teams'&&q.has('ids')){const requested=q.get('ids')!.split(',');names.push(requested);if(failLast&&requested.includes(ids[20]!))return route.fulfill({status:503,json:{error:{code:'SYNTHETIC_NAMES_FAILURE'}}});}return route.continue();
 });
 await page.goto('/teams/'+catalogTeamId);await page.getByLabel('Elo: карты отчёта',{exact:true}).selectOption('50');await page.getByLabel('Elo: срез (UTC)',{exact:true}).fill('2024-01-03T00:00');await page.getByRole('button',{name:'Применить период Elo',exact:true}).click();
 const table=page.getByRole('table',{name:'История Elo организации',exact:true}),panel=page.getByRole('region',{name:'Elo и сила соперников',exact:true});
 await expect(table.locator('tbody tr')).toHaveCount(23);await expect(table.locator(`a[href="/teams/${ids[0]}"]`)).toHaveText(['Synthetic Opponent Twin','Synthetic Opponent Twin']);
 await expect(table.locator(`a[href="/teams/${ids[2]}"]`)).toHaveText('Команда без названия');await expect(table.locator(`a[href="/teams/${ids[20]}"]`)).toHaveText('Имя недоступно');await expect(table.getByText('Команда не указана',{exact:true})).toBeVisible();
 expect(names.map(b=>b.length)).toEqual([20,1]);const reads=strengthReads,before=await table.locator('tbody tr').first().locator('td').allTextContents(),summary=await panel.getByRole('group',{name:'Рейтинг и сила соперников'}).innerText();
 await sql`UPDATE teams SET name='Synthetic Renamed Opponent' WHERE id=${ids[0]!}`.execute(database.db);
 await panel.getByRole('button',{name:'Обновить названия команд',exact:true}).click();await expect(table.locator(`a[href="/teams/${ids[0]}"]`)).toHaveText(['Synthetic Renamed Opponent','Synthetic Renamed Opponent']);
 expect(names).toHaveLength(4);expect(strengthReads).toBe(reads);expect((await table.locator('tbody tr').first().locator('td').allTextContents()).slice(1)).toEqual(before.slice(1));expect(await panel.getByRole('group',{name:'Рейтинг и сила соперников'}).innerText()).toBe(summary);
 failLast=true;await panel.getByRole('button',{name:'Обновить названия команд',exact:true}).click();await expect(panel.getByText('Часть названий команд недоступна.',{exact:false})).toBeVisible();await expect(table.locator(`a[href="/teams/${ids[0]}"]`)).toHaveText(['Synthetic Renamed Opponent','Synthetic Renamed Opponent']);
 expect(names).toHaveLength(6);failLast=false;await panel.getByRole('button',{name:'Повторить недоступные названия',exact:true}).click();await expect(panel.getByText('Часть названий команд недоступна.',{exact:false})).toHaveCount(0);expect(names).toHaveLength(7);expect(names[6]).toEqual([ids[20]]);expect(strengthReads).toBe(reads);
 await expect(panel.getByRole('group',{name:'Рейтинг и сила соперников'})).toContainText('N = 23');
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await panel.screenshot({path:'test-results/history-strength-labels-mobile.png'});
});
