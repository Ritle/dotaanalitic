import {test,expect} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedPredictionScenario} from '../../../../tests/helpers/predictions';
import {journalViewFixture} from '../../../../tests/helpers/journal-view';
import {ScenarioRepository,sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string,owner:string,id:string;
test.beforeAll(async()=>{
 database=await testDatabase();await seedPredictionScenario(database.db);password=randomBytes(24).toString('base64url');
 owner=(await new AuthService(database.db).provision('synthetic-prediction-labels',password)).id;
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});await api.listen({host:'127.0.0.1',port:3151});
});
test.afterAll(async()=>{await api?.close();await database?.close();});
test.beforeEach(async({page})=>{
 await sql`UPDATE teams SET name=CASE WHEN id=11 THEN 'Synthetic Named A' ELSE 'Synthetic Named B' END`.execute(database.db);
 await sql`UPDATE players SET nickname=CASE WHEN id IN(101,102) THEN 'Synthetic Twin' WHEN id=103 THEN '' ELSE 'Synthetic player' END`.execute(database.db);
 id=(await new ScenarioRepository(database.db).save(owner,(await import('../../../../packages/db/tests/v1-runtime-fixtures')).runtimeFixture().input)).id;
 await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-prediction-labels');await page.getByLabel('Пароль').fill(password);
 await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();
});

test('preview and frozen result share one bounded label batch; rename, missing names and503 never rewrite a forecast or block saving',async({page})=>{
 const lookups:string[]=[],errors:string[]=[];let fail=false;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/v1/catalog-labels?*',async route=>{
  lookups.push(route.request().url());if(fail)return route.fulfill({status:503,json:{error:{code:'SYNTHETIC_LABEL_FAILURE'}}});
  const response=await route.fetch(),body=await response.json();body.players=body.players.filter((p:{id:string})=>p.id!=='105');await route.fulfill({response,json:body});
 });
 await page.goto(`/scenarios/${id}/prediction`);const preview=page.getByRole('region',{name:'Новый расчёт',exact:true});
 await expect(preview.getByRole('link',{name:'Synthetic Named A',exact:true})).toBeVisible();expect(lookups).toHaveLength(1);
 const a=preview.getByRole('region',{name:'Выбранный состав A',exact:true});
 await expect(a.getByRole('link',{name:'Synthetic Twin',exact:true})).toHaveCount(2);
 await expect(a.locator('a[href="/players/103"]')).toHaveText('Игрок без ника');await expect(a.locator('a[href="/players/105"]')).toHaveText('Имя недоступно');
 await expect(a.getByText('Внутренний ID: 101',{exact:true})).not.toBeVisible();
 await preview.getByRole('button',{name:'Рассчитать и сохранить попытку',exact:true}).click();
 const result=page.getByRole('article',{name:'Сохранённый расчёт',exact:true});await expect(result.getByRole('heading',{name:'Прогноз недоступен',exact:true})).toBeVisible();
 await expect(result.getByRole('link',{name:'Synthetic Named A',exact:true})).toBeVisible();expect(lookups).toHaveLength(1);
 const requestId=new URL(page.url()).searchParams.get('prediction')!,url=`/api/v1/scenarios/${id}/predictions/${requestId}`;
 const original=await(await page.request.get(url)).json(),scenario=await new ScenarioRepository(database.db).get(owner,id);
 const frozen=(await sql`SELECT snapshot_text FROM v1_runtime_snapshots WHERE request_id=${requestId}::uuid`.execute(database.db)).rows;
 await sql`UPDATE teams SET name='Synthetic Renamed A' WHERE id=11`.execute(database.db);await sql`UPDATE players SET nickname='Synthetic Renamed Player' WHERE id=101`.execute(database.db);
 await expect(result.getByRole('link',{name:'Synthetic Named A',exact:true})).toBeVisible();
 await result.getByRole('button',{name:'Обновить подписи каталога',exact:true}).click();await expect(result.getByRole('link',{name:'Synthetic Renamed A',exact:true})).toBeVisible();
 await expect(result.locator('a[href="/players/101"]')).toHaveText('Synthetic Renamed Player');expect(lookups).toHaveLength(2);
 expect(await(await page.request.get(url)).json()).toEqual(original);expect(await new ScenarioRepository(database.db).get(owner,id)).toEqual(scenario);
 expect((await sql`SELECT snapshot_text FROM v1_runtime_snapshots WHERE request_id=${requestId}::uuid`.execute(database.db)).rows).toEqual(frozen);
 fail=true;await result.getByRole('button',{name:'Обновить подписи каталога',exact:true}).click();await expect(result.getByText('Не удалось обновить подписи каталога.',{exact:false})).toBeVisible();
 await expect(result.getByRole('link',{name:'Synthetic Renamed A',exact:true})).toBeVisible();
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await result.screenshot({path:'test-results/prediction-labels-mobile.png'});
 await page.reload();await expect(result.getByText('Не удалось обновить подписи каталога.',{exact:false})).toBeVisible();
 const saved=page.waitForResponse(r=>r.url().endsWith(`/scenarios/${id}/predictions`)&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Рассчитать и сохранить попытку',exact:true}).click();expect((await saved).status()).toBe(200);
 expect(await(await page.request.get(url)).json()).toEqual(original);
 fail=false;await result.getByRole('button',{name:'Обновить подписи каталога',exact:true}).click();await expect(result.getByRole('link',{name:'Synthetic Renamed A',exact:true})).toBeVisible();
 expect(await(await page.request.get(url)).json()).toEqual(original);
 for(const lookup of lookups){const q=new URL(lookup).searchParams;expect(q.get('teams')?.split(',')).toHaveLength(2);expect(q.get('players')?.split(',')).toHaveLength(10);expect(q.has('heroes')).toBe(false);}
 expect(errors).toEqual([]);
});

test('fifty journal rows fetch no labels until opened; repeated lineups and next page share cache without mutating report statistics',async({page})=>{
 const first=journalViewFixture(51),last=journalViewFixture(51,50),original=JSON.stringify([first,last]),lookups:string[]=[];
 await page.route('**/api/v1/forecast-journal/*',route=>route.fulfill({json:new URL(route.request().url()).searchParams.get('offset')==='50'?last:first}));
 page.on('request',r=>{if(r.url().includes('/catalog-labels?'))lookups.push(r.url());});
 await page.goto('/forecast-journal?report='+first.requestId);const report=page.getByRole('article',{name:'Сохранённый отчёт журнала',exact:true}),rows=report.locator('.attempt-table tbody > tr');
 await expect(rows).toHaveCount(50);expect(lookups).toEqual([]);await expect(report).toContainText('Метрики · N=1');
 const observed=(await rows.nth(0).locator('td').allTextContents()).slice(1,4);
 const summary=(row:ReturnType<typeof rows.nth>)=>row.locator('[data-forecast-lineups] > summary');
 await summary(rows.nth(0)).click();await expect(rows.nth(0).getByRole('link',{name:'Synthetic Named A',exact:true})).toBeVisible();expect(lookups).toHaveLength(1);
 await expect(rows.nth(0).getByRole('region',{name:'Ожидаемый состав A',exact:true}).getByRole('link',{name:'Synthetic Twin',exact:true})).toHaveCount(2);
 await summary(rows.nth(1)).click();await expect(rows.nth(1).getByRole('link',{name:'Synthetic Named A',exact:true})).toBeVisible();expect(lookups).toHaveLength(1);
 expect((await rows.nth(0).locator('td').allTextContents()).slice(1,4)).toEqual(observed);
 await summary(rows.nth(0)).click();await summary(rows.nth(0)).click();await expect(rows.nth(0).getByRole('link',{name:'Synthetic Named A',exact:true})).toBeVisible();expect(lookups).toHaveLength(1);
 await report.getByRole('button',{name:'Ранние попытки',exact:true}).click();await expect(rows).toHaveCount(1);expect(lookups).toHaveLength(1);
 await expect(rows.nth(0).locator('[data-forecast-lineups] > summary')).toBeVisible();await expect(rows.nth(0).getByRole('link',{name:'Synthetic Named A',exact:true})).toHaveCount(0);
 await summary(rows.nth(0)).focus();await page.keyboard.press('Enter');await expect(rows.nth(0).getByRole('link',{name:'Synthetic Named A',exact:true})).toBeVisible();expect(lookups).toHaveLength(1);
 await expect(report).toContainText('Метрики · N=1');expect(JSON.stringify([first,last])).toBe(original);
 expect((await sql`SELECT count(*)::int n FROM v1_journal_reports`.execute(database.db)).rows[0]!.n).toBe(0);
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/journal-labels-mobile.png',fullPage:true});
});
