import {test,expect} from '@playwright/test';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedPredictionScenario} from '../../../../tests/helpers/predictions';
import {journalViewFixture} from '../../../../tests/helpers/journal-view';
import {ScenarioRepository,V1RuntimeRepository,V1TargetLifecycleRepository,V1JournalRepository,sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string,owner:string,scenarioId:string;
test.beforeAll(async()=>{
  database=await testDatabase();const input=await seedPredictionScenario(database.db);password=randomBytes(24).toString('base64url');
  owner=(await new AuthService(database.db).provision('synthetic-journal-browser',password)).id;
  scenarioId=(await new ScenarioRepository(database.db).save(owner,input)).id;
  api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});
  await api.listen({host:'127.0.0.1',port:3151});
});
test.beforeEach(async({page})=>{
  await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-journal-browser');await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();
});
test.afterAll(async()=>{await api?.close();await database?.close();});

test('owner creates frozen empty/filtered reports and keeps old statistics across later attempts',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('link',{name:'Журнал прогнозов →',exact:true}).click();
  const history=page.getByRole('region',{name:'История отчётов',exact:true}),report=page.getByRole('article',{name:'Сохранённый отчёт журнала',exact:true});
  await expect(history).toContainText('Сохранённых отчётов пока нет');
  await page.getByRole('button',{name:'Создать и сохранить отчёт',exact:true}).click();
  await expect(report).toContainText('Метрики · N=0');await expect(report).toContainText('Метрики не рассчитаны');await expect(report).not.toContainText('50%');
  const oldUrl=page.url();
  await new V1RuntimeRepository(database.db).create(owner,{requestId:randomUUID(),scenarioId,expectedRevision:1,purpose:'what_if_single_map',targetScope:null});
  await page.getByLabel('Создан с · UTC',{exact:true}).fill('2099-02-01T00:00');await page.getByLabel('Создан до · UTC, не включая',{exact:true}).fill('2099-01-01T00:00');
  await page.getByRole('button',{name:'Создать и сохранить отчёт',exact:true}).click();await expect(page.getByRole('alert')).toContainText('начало раньше конца');
  await page.getByLabel('Создан с · UTC',{exact:true}).fill('');await page.getByLabel('Создан до · UTC, не включая',{exact:true}).fill('');
  await page.getByLabel('Статус',{exact:true}).selectOption('what_if');await page.getByRole('button',{name:'Создать и сохранить отчёт',exact:true}).click();
  await expect(report).toContainText('Условный расчёт');await expect(report).toContainText('Synthetic single map');
  await expect(report).toContainText('Статус: Условный расчёт');await expect(report).toContainText('не входит в статистику реальных прогнозов');
  await expect(report).toContainText('Расчёт недоступен');await expect(report).toContainText('Нет активной проверенной модели');
  await page.screenshot({path:'test-results/journal-desktop.png',fullPage:true});
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/journal-mobile.png',fullPage:true});
  await page.goto(oldUrl);await expect(report).toContainText('В этой странице выборки нет попыток');expect(errors).toEqual([]);
});
test('lost POST response retries the original request without duplicating a report',async({page})=>{
  let requestId='',blockRead=true;
  await page.route('**/api/v1/forecast-journal/*',route=>blockRead?route.fulfill({status:503,json:{error:{code:'SYNTHETIC_FAILURE'}}}):route.continue());
  await page.route('**/api/v1/forecast-journal',async route=>{
    if(route.request().method()!=='POST'||requestId)return route.continue();requestId=route.request().postDataJSON().requestId;
    await route.fetch();await route.abort('failed');
  });
  await page.goto('/forecast-journal');await page.getByRole('button',{name:'Создать и сохранить отчёт',exact:true}).click();
  await expect(page.getByRole('button',{name:'Повторить тот же запрос',exact:true})).toBeEnabled();blockRead=false;
  await page.getByRole('button',{name:'Повторить тот же запрос',exact:true}).click();
  await expect(page.getByRole('article',{name:'Сохранённый отчёт журнала',exact:true})).toContainText('Метрики · N=0');
  expect((await sql`SELECT 1 FROM v1_journal_reports WHERE request_id=${requestId}::uuid`.execute(database.db)).rows).toHaveLength(1);
});
test('synthetic positive report shows N, source hashes and bounded pages on mobile without persisting forecasts',async({page})=>{
  const fixture=journalViewFixture(51),second=journalViewFixture(51,50);
  await page.route(`**/api/v1/forecast-journal/${fixture.requestId}?offset=*`,route=>route.fulfill({json:route.request().url().endsWith('offset=50')?second:fixture}));
  await page.goto('/forecast-journal?report='+fixture.requestId);
  const report=page.getByRole('article',{name:'Сохранённый отчёт журнала',exact:true});
  await expect(report).toContainText('Метрики · N=1');await expect(report).toContainText('Синтетический пример журнала');
  await report.getByText('Таблица калибровки и правила расчёта',{exact:true}).click();await expect(report.getByRole('region',{name:'Таблица калибровки',exact:true})).toBeVisible();
  await report.getByRole('button',{name:'Ранние попытки',exact:true}).click();await expect(report).toContainText('Показаны 51–51 из 51');await expect(report).toContainText('Метрики · N=1');
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/journal-synthetic-positive.png',fullPage:true});
  expect((await sql`SELECT 1 FROM prediction_runs WHERE status='done'`.execute(database.db)).rows).toHaveLength(0);
});
test('expired session returns to login without appending a report',async({page})=>{
  const loaded=page.waitForResponse(r=>r.url().endsWith('/api/v1/forecast-journal')&&r.request().method()==='GET');
  await page.goto('/forecast-journal');await loaded;await expect(page.getByRole('button',{name:'Создать и сохранить отчёт',exact:true})).toBeVisible();
  const n=(await sql`SELECT count(*)::int n FROM v1_journal_reports`.execute(database.db)).rows[0]!.n;
  const me=await page.request.get('/api/v1/auth/me');await page.request.post('/api/v1/auth/logout',{headers:{origin:'http://127.0.0.1:5179','x-csrf-token':(await me.json()).csrfToken}});
  await page.getByRole('button',{name:'Создать и сохранить отчёт',exact:true}).click();await expect(page).toHaveURL(/\/login$/);
  expect((await sql`SELECT count(*)::int n FROM v1_journal_reports`.execute(database.db)).rows[0]!.n).toBe(n);
});
test('shows owner-reported cancellation and reopening while preserving the archived report',async({page})=>{
  const predictionRequestId=randomUUID(),lifecycle=new V1TargetLifecycleRepository(database.db),journal=new V1JournalRepository(database.db);
  await new V1RuntimeRepository(database.db).create(owner,{requestId:predictionRequestId,scenarioId,expectedRevision:1,purpose:'real_map',targetScope:null,
    realTarget:{provider:'opendota',providerSeriesId:'9007199254742999',mapNumber:1,sourceUrl:'https://example.test/synthetic',rationale:'Synthetic browser first-map target'}});
  const req={requestId:randomUUID(),predictionRequestId,expectedRevision:0,action:'cancelled',eventAt:null,
    sourceUrl:'https://example.test/synthetic-cancel',reason:'Синтетическая отмена встречи для проверки интерфейса'};
  await lifecycle.append(owner,req);
  await page.goto('/forecast-journal');await page.getByLabel('Статус',{exact:true}).selectOption('cancelled');
  await page.getByRole('button',{name:'Создать и сохранить отчёт',exact:true}).click();
  const report=page.getByRole('article',{name:'Сохранённый отчёт журнала',exact:true});
  await expect(report).toContainText('Отменённых назначений карты: 1');await expect(report).toContainText('Отменена · отметка владельца');
  await expect(report).toContainText('Расчёт недоступен');await expect(report).toContainText('Метрики · N=0');
  const oldUrl=page.url();await report.getByText('Сведения о прогнозе',{exact:true}).click();
  await expect(report).toContainText(req.reason);await expect(report).toContainText(req.sourceUrl);
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/journal-cancellation-mobile.png',fullPage:true});
  await lifecycle.append(owner,{...req,requestId:randomUUID(),expectedRevision:1,action:'reopened',reason:'Синтетическое повторное открытие встречи'});
  const reopened=await journal.create(owner,{requestId:randomUUID(),filters:{}});
  await page.goto('/forecast-journal?report='+reopened.report.request.requestId);await expect(report).toContainText('Отменённых назначений карты: 0');
  await page.goto(oldUrl);await expect(report).toContainText('Отменённых назначений карты: 1');
});
