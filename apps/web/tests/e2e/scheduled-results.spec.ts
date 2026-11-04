import {test,expect} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedScheduledResult} from '../../../../tests/helpers/scheduled-result';
import {sql,V1RuntimeRepository} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,f:Awaited<ReturnType<typeof seedScheduledResult>>,owner:string;
const root=()=>`**/api/v1/schedule-targets/${f.target.record.request.requestId}/forecasts/${f.forecast.snapshot.request.requestId}`;
const url=()=>`/schedule-targets/${f.target.record.request.requestId}?forecast=${f.forecast.snapshot.request.requestId}&scenario=${f.scenario.id}`;
test.beforeEach(async({page})=>{
  database=await testDatabase();const password=randomBytes(24).toString('base64url');owner=(await new AuthService(database.db).provision('synthetic-result-browser',password)).id;
  f=await seedScheduledResult(database.db,owner);api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});
  await api.listen({host:'127.0.0.1',port:3151});await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-result-browser');await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();
});
test.afterEach(async()=>{await api?.close();await database?.close();});
async function fill(page:import('@playwright/test').Page,matchId=f.matchId){
  await page.getByLabel('ID карты OpenDota',{exact:true}).fill(matchId);await page.getByLabel('ID серии OpenDota',{exact:true}).fill('321');
  await page.getByLabel('Источник сопоставления · HTTPS',{exact:true}).fill('https://example.test/synthetic-cross-provider-proof');
  await page.getByLabel('Объяснение сопоставления',{exact:true}).fill('Synthetic owner-reviewed exact meeting and first professional map association');
  await page.getByLabel('Я проверил, что это первая карта именно этой встречи',{exact:true}).check();
}
test('owner binds a verified map and freezes its checked outcome without altering the original forecast',async({page})=>{
  await page.goto(url());await fill(page);await page.getByRole('button',{name:'Сохранить связь с картой',exact:true}).click();
  const binding=page.getByRole('article',{name:'Сохранённая связь с картой',exact:true});await expect(binding).toContainText(f.matchId);await expect(binding).toContainText('Ручное сопоставление');
  await page.getByRole('button',{name:'Проверить и сохранить результат',exact:true}).click();
  const outcome=page.getByRole('article',{name:'Сохранённая сверка результата',exact:true});await expect(outcome).toContainText('Победа команды A');await expect(outcome).toContainText('Совпадение составов: Совпал');
  await expect(outcome).toContainText('Вероятность не была выдана');await expect(outcome).toContainText('фактическое начало');
  await page.screenshot({path:'test-results/scheduled-result-owner-desktop.png',fullPage:true});await page.setViewportSize({width:360,height:800});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/scheduled-result-owner-mobile.png',fullPage:true});
  await page.reload();await expect(binding).toContainText(f.matchId);await expect(outcome).toContainText('Сверка · редакция 1');
  expect((await new V1RuntimeRepository(database.db).get(owner,f.forecast.snapshot.request.requestId))?.sha256).toBe(f.forecast.sha256);
});
test('lost binding and refresh responses replay identical requests and retain old facts until a fresh verification',async({page})=>{
  const bindings:string[]=[],refreshes:string[]=[];await page.route(root()+'/result-binding',async route=>{
    if(route.request().method()!=='POST')return route.continue();bindings.push(route.request().postData()!);
    if(bindings.length===1){await route.fetch();await route.abort('failed');}else await route.continue();
  });
  await page.route(root()+'/outcomes',async route=>{
    if(route.request().method()!=='POST')return route.continue();refreshes.push(route.request().postData()!);
    if(refreshes.length===1){await route.fetch();await f.ingest(false);await route.abort('failed');}else await route.continue();
  });
  await page.goto(url());await fill(page);await page.getByRole('button',{name:'Сохранить связь с картой',exact:true}).click();
  await page.getByRole('button',{name:'Повторить сохранение той же связи',exact:true}).click();await expect(page.getByRole('article',{name:'Сохранённая связь с картой',exact:true})).toContainText(f.matchId);
  expect(bindings).toHaveLength(2);expect(bindings[0]).toBe(bindings[1]);
  await page.getByRole('button',{name:'Проверить и сохранить результат',exact:true}).click();await page.getByRole('button',{name:'Повторить ту же сверку',exact:true}).click();
  const outcome=page.getByRole('article',{name:'Сохранённая сверка результата',exact:true});await expect(outcome).toContainText('Победа команды A');
  expect(refreshes).toHaveLength(2);expect(refreshes[0]).toBe(refreshes[1]);
  await page.getByRole('button',{name:'Проверить и сохранить результат',exact:true}).click();await expect(outcome).toContainText('Сверка · редакция 2');await expect(outcome).toContainText('Победа команды B');
  await page.getByRole('button',{name:/^Сверка 1 ·/}).click();await expect(outcome).toContainText('Победа команды A');await expect(outcome).toContainText('архивную редакцию');
  expect((await sql`SELECT 1 FROM v1_schedule_result_bindings`.execute(database.db)).rows).toHaveLength(1);
  expect((await sql`SELECT 1 FROM v1_forecast_outcome_revisions`.execute(database.db)).rows).toHaveLength(2);
});
test('unverified map is refused and changing the association requires a renewed owner confirmation',async({page})=>{
  await page.goto(url());await fill(page,'999');await page.getByRole('button',{name:'Сохранить связь с картой',exact:true}).click();
  const panel=page.getByRole('region',{name:'Связь с результатом карты',exact:true});await expect(panel).toContainText('Карта не прошла проверку');
  expect((await sql`SELECT 1 FROM v1_schedule_result_bindings`.execute(database.db)).rows).toHaveLength(0);
  await page.getByRole('button',{name:'Перечитать связь и сверки',exact:true}).click();await page.getByLabel('ID карты OpenDota',{exact:true}).fill(f.matchId);
  await expect(page.getByLabel('Я проверил, что это первая карта именно этой встречи',{exact:true})).not.toBeChecked();
  await page.getByLabel('Я проверил, что это первая карта именно этой встречи',{exact:true}).check();await page.getByRole('button',{name:'Сохранить связь с картой',exact:true}).click();
  await expect(page.getByRole('article',{name:'Сохранённая связь с картой',exact:true})).toContainText(f.matchId);
});
