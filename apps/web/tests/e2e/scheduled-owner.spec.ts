import {test,expect} from '@playwright/test';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedPredictionScenario} from '../../../../tests/helpers/predictions';
import {publishTargetSchedule,syntheticTargetMatch} from '../../../../tests/helpers/schedule-target';
import {ScenarioRepository,V1ScheduleTargetRepository,sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string,owner:string;
let base:Awaited<ReturnType<typeof seedPredictionScenario>>,counter=0;
test.beforeAll(async()=>{
  database=await testDatabase();base=await seedPredictionScenario(database.db);password=randomBytes(24).toString('base64url');
  owner=(await new AuthService(database.db).provision('synthetic-scheduled-owner-browser',password)).id;
  api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});
  await api.listen({host:'127.0.0.1',port:3151});
});
test.beforeEach(async({page})=>{
  await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-scheduled-owner-browser');await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();
});
test.afterAll(async()=>{await api?.close();await database?.close();});
async function fixture(map:number|null=1){
  counter++;const match=syntheticTargetMatch({providerMatchId:String(9007199254742999n+BigInt(counter)),name:'Synthetic Owner Meeting '+counter,scheduledAt:base.scheduledAt});
  await publishTargetSchedule(database.db,[match]);const targets=new V1ScheduleTargetRepository(database.db),p=await targets.preview(match.providerMatchId);
  const target=await targets.create(owner,{requestId:randomUUID(),providerMatchId:match.providerMatchId,observationId:p.observation.id,observationSha256:p.observation.snapshotSha256,
    expectedRevision:0,mapNumber:1,providerTeamAId:'74',providerTeamBId:'75',teamAId:'11',teamBId:'22',leagueId:'77',reviewSourceUrl:'https://example.test/synthetic-owner-review',reason:'Synthetic reviewed owner target mapping'});
  const scenario=await new ScenarioRepository(database.db).save(owner,{...base,title:'Synthetic selected 5v5 '+counter,context:{...base.context,mapNumber:map}});
  return {match,target,scenario,url:'/schedule-targets/'+target.record.request.requestId};
}
test('owner calculates from the saved meeting and keeps the frozen five and bookmark after later edits',async({page})=>{
  const f=await fixture();await page.goto(f.url);
  await expect(page.getByRole('article',{name:'Сохранённое назначение карты',exact:true})).toBeVisible();
  await page.getByLabel('Сохранённый сценарий',{exact:true}).selectOption(f.scenario.id);
  await expect(page.getByRole('region',{name:'Прогноз назначенной карты'})).toContainText('Команды, турнир, время и карта 1 совпадают');
  await page.getByRole('button',{name:'Рассчитать назначенную карту',exact:true}).click();
  const result=page.getByRole('article',{name:'Сохранённый расчёт',exact:true});await expect(result).toContainText('Нет активной проверенной модели');
  await expect(result).toContainText('Прогноз для назначенной карты');await expect(result).not.toContainText('50 %');await expect(result).toContainText(f.scenario.input.title);
  const url=page.url();await page.screenshot({path:'test-results/scheduled-owner-desktop.png',fullPage:true});
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/scheduled-owner-mobile.png',fullPage:true});
  await new ScenarioRepository(database.db).save(owner,{...f.scenario.input,title:'Synthetic later title'},{id:f.scenario.id,expectedRevision:1});
  await page.goto(url);await expect(result).toContainText(f.scenario.input.title);await expect(result).toContainText('сохранённая редакция 1');
  await expect(page.getByText('Сохранённый расчёт относится к редакции 1. Текущая редакция сценария 2.',{exact:true})).toBeVisible();
  const rows=(await sql`SELECT snapshot_text::jsonb#>>'{request,purpose}' purpose FROM v1_runtime_snapshots WHERE schedule_target_request_id=${f.target.record.request.requestId}::uuid`.execute(database.db)).rows;
  expect(rows).toEqual([{purpose:'real_map'}]);
});
test('lost POST response retries the same UUID and frozen body even after the meeting starts',async({page})=>{
  const f=await fixture(),bodies:string[]=[];let blockRead=true;
  await page.route('**/api/v1/schedule-targets/'+f.target.record.request.requestId+'/forecasts/**',route=>blockRead?route.fulfill({status:503,json:{error:{code:'SYNTHETIC_FAILURE'}}}):route.continue());
  await page.route('**/api/v1/schedule-targets/'+f.target.record.request.requestId+'/forecasts',async route=>{
    if(route.request().method()!=='POST')return route.continue();bodies.push(route.request().postData()!);
    if(bodies.length===1){await route.fetch();await publishTargetSchedule(database.db,[{...f.match,status:'running'}]);await route.abort('failed');}
    else{blockRead=false;await route.continue();}
  });
  await page.goto(f.url);await page.getByLabel('Сохранённый сценарий',{exact:true}).selectOption(f.scenario.id);
  await page.getByRole('button',{name:'Рассчитать назначенную карту',exact:true}).click();
  await page.getByRole('button',{name:'Повторить тот же запрос',exact:true}).click();
  await expect(page.getByRole('article',{name:'Сохранённый расчёт',exact:true})).toContainText(f.scenario.input.title);
  expect(bodies).toHaveLength(2);expect(bodies[0]).toBe(bodies[1]);
  expect((await sql`SELECT 1 FROM v1_runtime_snapshots WHERE schedule_target_request_id=${f.target.record.request.requestId}::uuid`.execute(database.db)).rows).toHaveLength(1);
});
test('prepares a separate scenario from the target with empty players and returns after manual confirmation',async({page})=>{
  const f=await fixture(null);await page.goto(f.url);await page.getByLabel('Сохранённый сценарий',{exact:true}).selectOption(f.scenario.id);
  await expect(page.getByRole('button',{name:'Рассчитать назначенную карту',exact:true})).toBeDisabled();
  await expect(page.getByRole('region',{name:'Прогноз назначенной карты'})).toContainText('выберите карту 1');
  await page.getByRole('link',{name:'Подготовить новый сценарий для этой встречи →',exact:true}).click();
  await expect(page.getByLabel('Название',{exact:true})).toHaveValue(f.match.name!);await expect(page.getByLabel('Команда A: ID организации',{exact:true})).toHaveValue('11');
  await expect(page.getByLabel('A: игрок роли 1',{exact:true})).toHaveValue('');
  for(let i=1;i<=5;i++){await page.getByLabel('A: игрок роли '+i,{exact:true}).fill(String(i+100));await page.getByLabel('B: игрок роли '+i,{exact:true}).fill(String(i+105));}
  await page.getByLabel('Подтверждаю выбранные 5+5, роли и необязательные ожидаемые составы',{exact:true}).check();await page.getByRole('button',{name:'Сохранить сценарий',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Сценарий · редакция 1',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'← Вернуться к назначению карты',exact:true}).click();
  await expect(page.getByRole('region',{name:'Прогноз назначенной карты'})).toContainText('Команды, турнир, время и карта 1 совпадают');
  await page.getByRole('button',{name:'Рассчитать назначенную карту',exact:true}).click();
  await expect(page.getByRole('article',{name:'Сохранённый расчёт',exact:true})).toContainText('Прогноз недоступен');
});
test('changed source requires a fresh review and cannot silently create a prediction',async({page})=>{
  const f=await fixture();await page.goto(f.url);await page.getByLabel('Сохранённый сценарий',{exact:true}).selectOption(f.scenario.id);
  await expect(page.getByRole('button',{name:'Рассчитать назначенную карту',exact:true})).toBeEnabled();
  await publishTargetSchedule(database.db,[{...f.match,scheduledAt:'2099-01-03T00:00:00.000Z'}]);
  await page.getByRole('button',{name:'Рассчитать назначенную карту',exact:true}).click();
  await expect(page.getByRole('region',{name:'Прогноз назначенной карты'})).toContainText('Расписание изменилось');
  expect((await sql`SELECT 1 FROM v1_runtime_snapshots WHERE schedule_target_request_id=${f.target.record.request.requestId}::uuid`.execute(database.db)).rows).toHaveLength(0);
});
