import {test,expect} from '@playwright/test';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedScheduledResult} from '../../../../tests/helpers/scheduled-result';
import {sql,V1ScheduledLifecycleRepository,V1RuntimeRepository,V1JournalRepository} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,f:Awaited<ReturnType<typeof seedScheduledResult>>,owner:string;
const url=()=>`/schedule-targets/${f.target.record.request.requestId}`;
const panel=(page:import('@playwright/test').Page)=>page.getByRole('region',{name:'Отмена и открытие встречи',exact:true});
const request=(expectedRevision:number,action:'cancelled'|'reopened')=>({requestId:randomUUID(),targetRequestId:f.target.record.request.requestId,expectedRevision,action,
  eventAt:null,sourceUrl:'https://example.test/synthetic-lifecycle',reason:'Synthetic owner-reviewed lifecycle event'});
test.beforeEach(async({page})=>{
  database=await testDatabase();const password=randomBytes(24).toString('base64url');owner=(await new AuthService(database.db).provision('synthetic-lifecycle-browser',password)).id;
  f=await seedScheduledResult(database.db,owner);api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});
  await api.listen({host:'127.0.0.1',port:3151});await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-lifecycle-browser');await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();
});
test.afterEach(async()=>{await api?.close();await database?.close();});
async function fill(page:import('@playwright/test').Page){
  await page.getByLabel('Источник отметки',{exact:true}).fill('https://example.test/synthetic-lifecycle');
  await page.getByLabel('Причина отметки',{exact:true}).fill('Synthetic owner-reviewed lifecycle event');
  await page.getByLabel('Подтверждаю изменение состояния всей встречи',{exact:true}).check();
}
test('owner cancels, journals and reopens a meeting with preserved forecasts, reports and mobile history',async({page})=>{
  await page.goto(url());await fill(page);await panel(page).getByRole('button',{name:'Отметить отмену встречи',exact:true}).click();
  await expect(panel(page)).toContainText('Отмечена отмена владельцем');await expect(panel(page)).toContainText('Отмена · редакция 1');
  await page.screenshot({path:'test-results/scheduled-lifecycle-desktop.png',fullPage:true});await page.setViewportSize({width:360,height:800});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/scheduled-lifecycle-mobile.png',fullPage:true});
  await page.goto('/forecast-journal');await page.getByRole('button',{name:'Создать и сохранить отчёт',exact:true}).click();
  await page.getByText('Сведения о прогнозе',{exact:true}).click();
  await expect(page.getByText(/Отметка владельца: отмена/)).toBeVisible();
  const journal=new V1JournalRepository(database.db),reportId=(await sql<{request_id:string}>`SELECT request_id FROM v1_journal_reports ORDER BY revision DESC LIMIT 1`.execute(database.db)).rows[0]!.request_id;
  const old=await journal.get(owner,reportId);expect(old.report.summary.counts.cancelled).toBe(1);
  await page.goto(url());await fill(page);await panel(page).getByRole('button',{name:'Повторно открыть встречу',exact:true}).click();
  await expect(panel(page)).toContainText('Повторно открыта владельцем');await expect(panel(page)).toContainText('Повторное открытие · редакция 2');
  await page.reload();await expect(panel(page)).toContainText('Повторное открытие · редакция 2');
  expect(await journal.get(owner,reportId)).toEqual(old);
  expect((await new V1RuntimeRepository(database.db).get(owner,f.forecast.snapshot.request.requestId))?.sha256).toBe(f.forecast.sha256);
});
test('lost response retries the original cancellation even after a concurrent reopening',async({page})=>{
  const bodies:string[]=[];await page.route(`**/api/v1/schedule-targets/${f.target.record.request.requestId}/lifecycle`,async route=>{
    if(route.request().method()!=='POST')return route.continue();bodies.push(route.request().postData()!);
    if(bodies.length===1){await route.fetch();await new V1ScheduledLifecycleRepository(database.db).append(owner,request(1,'reopened'));await route.abort('failed');}
    else await route.continue();
  });
  await page.goto(url());await fill(page);await panel(page).getByRole('button',{name:'Отметить отмену встречи',exact:true}).click();
  await panel(page).getByRole('button',{name:'Повторить ту же отметку',exact:true}).click();
  await expect(panel(page)).toContainText('Повторно открыта владельцем');expect(bodies).toHaveLength(2);expect(bodies[0]).toBe(bodies[1]);
  expect((await sql`SELECT 1 FROM v1_scheduled_lifecycle`.execute(database.db)).rows).toHaveLength(2);
  await expect(page.getByLabel('Подтверждаю изменение состояния всей встречи',{exact:true})).not.toBeChecked();
});
test('CAS conflict requires rereading and renewed confirmation; edits reset approval',async({page})=>{
  let intercepted=false;await page.route(`**/api/v1/schedule-targets/${f.target.record.request.requestId}/lifecycle`,async route=>{
    if(route.request().method()==='POST'&&!intercepted){intercepted=true;await new V1ScheduledLifecycleRepository(database.db).append(owner,request(0,'cancelled'));}
    await route.continue();
  });
  await page.goto(url());await fill(page);await page.getByLabel('Причина отметки',{exact:true}).fill('Synthetic changed and reviewed explanation');
  await expect(page.getByLabel('Подтверждаю изменение состояния всей встречи',{exact:true})).not.toBeChecked();
  await page.getByLabel('Подтверждаю изменение состояния всей встречи',{exact:true}).check();
  await panel(page).getByRole('button',{name:'Отметить отмену встречи',exact:true}).click();await expect(panel(page)).toContainText('История встречи изменилась');
  await panel(page).getByRole('button',{name:'Перечитать состояние встречи',exact:true}).click();await expect(panel(page)).toContainText('Отмечена отмена владельцем');
  await expect(page.getByLabel('Подтверждаю изменение состояния всей встречи',{exact:true})).not.toBeChecked();
  await page.getByLabel('Подтверждаю изменение состояния всей встречи',{exact:true}).check();
  await panel(page).getByRole('button',{name:'Повторно открыть встречу',exact:true}).click();await expect(panel(page)).toContainText('Повторно открыта владельцем');
});
