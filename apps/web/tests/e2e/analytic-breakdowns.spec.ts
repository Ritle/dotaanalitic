import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedSamples} from '../../../../tests/helpers/sample';
import {catalogPlayerId} from '../../../../tests/helpers/catalog';
import {sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string;
const localPatch='9007199254742999';
test.beforeAll(async()=>{
 database=await testDatabase();await seedSamples(database.db);password=randomBytes(24).toString('base64url');
 await new AuthService(database.db).provision('synthetic-analytic-labels',password);
 await sql`INSERT INTO patches(id,label,released_at) VALUES(${localPatch},'Synthetic big local patch','2025-01-01')`.execute(database.db);
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});await api.listen({host:'127.0.0.1',port:3151});
});
test.afterAll(async()=>{await api?.close();await database?.close();});
async function enter(page:Page){await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-analytic-labels');await page.getByLabel('Пароль').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();}

test('private analytic batches retain bigint local namespaces and cannot mix search, exceed20 or write catalogue rows',async({page})=>{
 expect((await page.request.get('/api/v1/context-catalog?kind=patches&ids=1')).status()).toBe(401);
 await enter(page);
 const before=(await sql`SELECT id::text,label FROM patches ORDER BY id`.execute(database.db)).rows;
 for(const [kind,ids] of [['patches',`${localPatch},1,1,9999`],['heroes','1,2,9999']]){
  const response=await page.request.get('/api/v1/context-catalog?'+new URLSearchParams({kind:kind!,ids:ids!}));expect(response.status()).toBe(200);
  const d=await response.json();expect(d.kind).toBe(kind);expect(d.hasMore).toBe(false);expect(Object.keys(d).sort()).toEqual(['hasMore','items','kind','readAt','source']);
  expect(d.items).toHaveLength(2);if(kind==='patches')expect(d.items).toContainEqual({id:localPatch,name:'Synthetic big local patch'});
 }
 const twenty=Array.from({length:20},(_,i)=>String(i+1));
 expect((await page.request.get('/api/v1/context-catalog?'+new URLSearchParams({kind:'patches',ids:twenty.join(',')}))).status()).toBe(200);
 for(const q of [{kind:'patches',ids:[...twenty,'21'].join(',')},{kind:'heroes',ids:'1',query:'name'},
  {kind:'patches',ids:'1',id:'1'},{kind:'heroes',ids:'1',offset:'1'},{kind:'patches',ids:'0'},{kind:'heroes',ids:'1);DROP TABLE heroes'}])expect((await page.request.get('/api/v1/context-catalog?'+new URLSearchParams(q))).status()).toBe(400);
 expect((await sql`SELECT id::text,label FROM patches ORDER BY id`.execute(database.db)).rows).toEqual(before);
});

test('prior and reference patch counts use shared names, keep unknowns and preserve all numbers through rename/error/retry',async({page})=>{
 await enter(page);await page.goto('/players/'+catalogPlayerId);
 await page.getByLabel('Герои: начало периода (UTC)',{exact:true}).fill('2024-01-01T00:00');await page.getByLabel('Герои: срез истории (UTC)',{exact:true}).fill('2024-01-03T00:00');
 await page.getByRole('region',{name:'Герои: герой',exact:true}).getByText('Технический ID',{exact:true}).click();await page.getByLabel('Герои: ID героя',{exact:true}).fill('1');await page.getByLabel('Герои: подтверждённая позиция',{exact:true}).selectOption('1');
 const received=page.waitForResponse(r=>r.url().includes(`/players/${catalogPlayerId}/heroes?`)&&r.url().includes('fromAt='));await page.getByRole('button',{name:'Применить фильтры героев',exact:true}).click();const frozen=await(await received).json();
 const panel=page.locator('[aria-labelledby="player-hero-title"]'),prior=panel.getByRole('group',{name:'Сглаженная историческая оценка',exact:true});
 await expect(prior.locator('[data-analytic-kind="heroes"]')).toContainText('Synthetic Hero');await expect(prior.locator('[data-analytic-kind="patches"]')).toContainText('synthetic reviewed');await expect(prior).toContainText('объём prior 3 карт');
 await panel.getByText('Ранний pro-пул и prior',{exact:true}).click();const reference=panel.getByRole('table',{name:'Глобальные и патчевые reference показатели',exact:true});await expect(reference.locator('[data-analytic-kind="heroes"]').first()).toContainText('Synthetic Hero');
 const values=await reference.locator('[data-patch-count]').allTextContents();expect(values.length).toBeGreaterThan(0);
 await sql`UPDATE patches SET label='Synthetic Renamed Patch' WHERE id=1`.execute(database.db);await sql`UPDATE heroes SET localized_name='Synthetic Renamed Prior Hero' WHERE id=1`.execute(database.db);
 const requests:string[]=[];page.on('request',r=>{if(r.url().includes('/context-catalog?')&&new URL(r.url()).searchParams.has('ids'))requests.push(r.url());});
 await panel.getByRole('button',{name:'Обновить подписи аналитики',exact:true}).click();await expect(prior.locator('[data-analytic-kind="patches"]')).toContainText('Synthetic Renamed Patch');await expect(prior.locator('[data-analytic-kind="heroes"]')).toContainText('Synthetic Renamed Prior Hero');
 expect(requests).toHaveLength(2);expect(await reference.locator('[data-patch-count]').allTextContents()).toEqual(values);await expect(prior).toContainText('объём prior 3 карт');
 let failed=true;await page.route('**/api/v1/context-catalog?*',r=>new URL(r.request().url()).searchParams.has('ids')&&new URL(r.request().url()).searchParams.get('kind')==='patches'&&failed?r.fulfill({status:503,json:{error:{code:'SYNTHETIC_METADATA_FAILURE'}}}):r.continue());
 await panel.getByRole('button',{name:'Обновить подписи аналитики',exact:true}).click();await expect(panel.getByText('Часть подписей аналитики недоступна.',{exact:false})).toBeVisible();expect(await reference.locator('[data-patch-count]').allTextContents()).toEqual(values);await expect(prior).toContainText('Synthetic Renamed Patch');
 requests.length=0;failed=false;await panel.getByRole('button',{name:'Повторить недоступные подписи аналитики',exact:true}).click();await expect(panel.getByText('Часть подписей аналитики недоступна.',{exact:false})).toHaveCount(0);expect(requests).toHaveLength(1);expect(new URL(requests[0]!).searchParams.get('kind')).toBe('patches');
 expect((await(await page.request.get(`/api/v1/players/${catalogPlayerId}/heroes?${new URLSearchParams({patchScope:'current',heroId:'1',rolePos:'1',fromAt:'2024-01-01T00:00:00.000Z',cutoffAt:'2024-01-03T00:00:00.000Z'})}`)).json()).smoothing).toEqual(frozen.smoothing);
 await page.route('**/api/v1/context-catalog?*',async r=>{
  const q=new URL(r.request().url()).searchParams;
  if(q.has('ids')&&q.get('kind')==='patches'){const response=await r.fetch();const d=await response.json();await r.fulfill({response,json:{...d,items:[]}});}else await r.continue();
 });
 await panel.getByRole('button',{name:'Обновить подписи аналитики',exact:true}).click();await expect(prior.locator('[data-analytic-kind="patches"]')).toContainText('Название патча недоступно');
 await prior.locator('[data-analytic-kind="patches"] summary').click();await expect(prior.locator('[data-analytic-kind="patches"]').getByText('Локальный ID: 1',{exact:true})).toBeVisible();
 await page.unroute('**/api/v1/context-catalog?*');await sql`UPDATE patches SET label=' ' WHERE id=1`.execute(database.db);
 await panel.getByRole('button',{name:'Обновить подписи аналитики',exact:true}).click();await expect(prior.locator('[data-analytic-kind="patches"]')).toContainText('Патч без названия');expect(await reference.locator('[data-patch-count]').allTextContents()).toEqual(values);
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await prior.screenshot({path:'test-results/analytic-prior-mobile.png'});
 // One real synthetic map outside verified release coverage remains an unknown patch.
 await sql`UPDATE matches SET started_at='2022-01-01T00:00:00Z' WHERE id=9001`.execute(database.db);
 await page.getByLabel('До момента (UTC)',{exact:true}).fill('2024-01-03T00:00');await page.getByRole('button',{name:'Применить фильтры',exact:true}).click();
 const maps=page.locator('[aria-labelledby="maps-title"]');await expect(maps.locator('[data-distribution-patch="unknown"]')).toContainText('Патч неизвестен');await expect(maps.locator('[data-distribution-patch="unknown"] [data-patch-count]')).toHaveText('1');
});
