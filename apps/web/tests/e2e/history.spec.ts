import {test,expect} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {syntheticHistoryProvider} from '../../../../tests/helpers/history-refresh';
import {sql} from '../../../../packages/db/src/index';
import {createHistoryQueue,registerHistoryWorker,HISTORY_QUEUE} from '../../../../packages/ingestion/dist/index.js';
import {buildApp} from '../../../api/src/app';import {readConfig} from '../../../api/src/config';import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,boss:Awaited<ReturnType<typeof createHistoryQueue>>,password:string;
let mode:'ok'|'partial'|'fail'='ok',gate:Promise<void>|undefined,release:()=>void=()=>undefined;
test.beforeAll(async()=>{
  database=await testDatabase();await sql`INSERT INTO teams(id,opendota_team_id,name) VALUES
    (101,31,'Synthetic history browser A'),(102,32,'Synthetic history browser partial'),(103,NULL,'Synthetic history unavailable')`.execute(database.db);
  password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-history-browser',password);
  api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});
  await api.listen({port:3151,host:'127.0.0.1'});boss=await createHistoryQueue(database.url);
  await registerHistoryWorker(boss,database.db,()=>syntheticHistoryProvider({mode,gate}));
});
test.afterAll(async()=>{release();await boss?.offWork(HISTORY_QUEUE);await boss?.stop({graceful:true,timeout:10000});await api?.close();await database?.close();});
async function signIn(page:import('@playwright/test').Page){
  await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-history-browser');await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('button',{name:'Выйти',exact:true})).toBeVisible();
}
test('owner starts a durable bounded refresh, sees running/completed state and statistics refresh without duplicate clicks',async({page})=>{
  mode='ok';gate=new Promise(resolve=>{release=resolve;});await signIn(page);await page.goto('/teams/101');
  const panel=page.getByRole('region',{name:'Обновление pro-истории'}),maps=page.locator('[aria-labelledby="maps-title"]');
  await expect(maps.getByText('N = 0',{exact:true})).toBeVisible();const start=panel.getByRole('button',{name:'Загрузить последние pro-карты',exact:true});
  await expect(start).toBeEnabled();await start.click();await expect(panel.getByRole('button',{name:'Обновление выполняется',exact:true})).toBeDisabled();
  await expect(panel.getByRole('status')).toContainText('Выполняется',{timeout:10000});
  const id=(await sql<{id:string}>`SELECT id FROM history_refresh_runs WHERE team_id=101`.execute(database.db)).rows;
  expect(id).toHaveLength(1);await page.reload();await expect(panel.getByRole('button',{name:'Обновление выполняется',exact:true})).toBeDisabled();
  release();gate=undefined;await expect(panel.getByRole('status')).toContainText('Завершено',{timeout:15000});
  await expect(panel.getByText(/Обработано 2 из 2/)).toBeVisible();await expect(maps.getByText('N = 2',{exact:true})).toBeVisible();
  await expect(panel.getByText(/Источник получен:/)).toBeVisible();await expect(panel.getByText(/Следующее обновление:/)).toBeVisible();
  await expect(panel.getByRole('button',{name:'Загрузить последние pro-карты',exact:true})).toBeDisabled();
  await panel.screenshot({path:'test-results/history-refresh-desktop.png'});await page.setViewportSize({width:360,height:900});
  await panel.screenshot({path:'test-results/history-refresh-mobile.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect((await sql`SELECT id FROM history_refresh_runs WHERE team_id=101`.execute(database.db)).rows).toHaveLength(1);
});
test('source partial result, status request retry and missing numeric organization ID remain explicit',async({page})=>{
  mode='partial';await signIn(page);await page.goto('/teams/102');const panel=page.getByRole('region',{name:'Обновление pro-истории'});
  await page.route('**/api/v1/teams/102/history-refresh',route=>route.request().method()==='GET'?
    route.fulfill({status:503,json:{error:{code:'SYNTHETIC_FAILURE'}}}):route.continue());
  await page.reload();await expect(panel.getByRole('alert')).toBeVisible();await page.unroute('**/api/v1/teams/102/history-refresh');
  await panel.getByRole('button',{name:'Проверить снова',exact:true}).click();
  await expect(panel.getByRole('button',{name:'Загрузить последние pro-карты',exact:true})).toBeEnabled();
  await panel.getByRole('button',{name:'Загрузить последние pro-карты',exact:true}).click();
  await expect(panel.getByRole('status')).toContainText('Частично',{timeout:15000});await expect(panel.getByText(/ошибок источника 1/)).toBeVisible();
  await expect(page.locator('[aria-labelledby="maps-title"]').getByText('N = 1',{exact:true})).toBeVisible();
  await page.goto('/teams/103');await expect(panel.getByText(/нет подтверждённого числового ID OpenDota/)).toBeVisible();
  await expect(panel.getByRole('button',{name:'Загрузить последние pro-карты',exact:true})).toBeDisabled();
});
