import {LineupTemplateRepository} from '../../../api/src/modules/catalog/lineup-templates-repository';
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
  await expect(page.getByRole('region',{name:'Выбранный состав A',exact:true}).locator('a[href="/players/101"]')).toHaveText('Synthetic player');
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
test('requires confirmed templates then prepares a map without a second lineup confirmation',async({page})=>{
  const f=await fixture(null);await page.goto(f.url);await page.getByLabel('Сохранённый сценарий',{exact:true}).selectOption(f.scenario.id);
  await expect(page.getByRole('button',{name:'Рассчитать назначенную карту',exact:true})).toBeDisabled();
  await expect(page.getByRole('region',{name:'Прогноз назначенной карты'})).toContainText('выберите карту 1');
  await page.getByRole('link',{name:'Подготовить новый сценарий для этой встречи →',exact:true}).click();
  await expect(page.getByLabel('Название',{exact:true})).toHaveValue(f.match.name!);
  await expect(page.getByRole('button',{name:'Сохранить карту',exact:true})).toBeDisabled();
  await expect(page.getByRole('link',{name:'Подготовить составы встречи →',exact:true})).toBeVisible();
  await expect(page.getByLabel('A: игрок 1',{exact:true})).toHaveCount(0);
  const templates=new LineupTemplateRepository(database.db);
  for(const [teamId,lineup] of [['11',base.lineupA],['22',base.lineupB]] as const){
    const old=await templates.report(teamId);
    await templates.save(owner,teamId,{requestId:randomUUID(),expectedRevision:old.current?.revision??0,confirmedByOwner:true,lineup:lineup.map(p=>({playerId:p.playerId!,rolePos:p.rolePos}))});
  }
  await page.getByRole('button',{name:'Повторить загрузку составов',exact:true}).click();
  await page.getByText('Параметры карты и составы',{exact:true}).click();await page.getByText('Подтверждённые игроки и роли',{exact:true}).click();
  await expect(page.getByRole('region',{name:'Подтверждённый состав A',exact:true})).toContainText('Carry');
  await expect(page.getByLabel('Подтверждаю выбранные 5+5, роли и необязательные ожидаемые составы',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Сохранить карту',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Сценарий · редакция 1',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Открыть Draft Lab →',exact:true}).click();
  expect(new URL(page.url()).searchParams.get('scheduleTarget')).toBe(f.target.record.request.requestId);
  await expect(page.getByRole('link',{name:'Открыть расчёт одной карты',exact:true})).toHaveAttribute('href',f.url+'?scenario='+new URL(page.url()).pathname.split('/')[2]);
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

test('direct saved map preserves frozen roles after template changes and saves map context without reconfirmation',async({page})=>{
 const f=await fixture();const templates=new LineupTemplateRepository(database.db),old=await templates.report('11');
 await templates.save(owner,'11',{requestId:randomUUID(),expectedRevision:old.current?.revision??0,confirmedByOwner:true,
   lineup:base.lineupA.map(p=>({playerId:p.playerId!,rolePos:6-p.rolePos}))});
 const requests:string[]=[];page.on('request',r=>{if(new URL(r.url()).pathname.match(/^\/api\/v1\/teams\/[^/]+\/lineup-template$/))requests.push(r.url());});
 await page.goto('/scenarios/'+f.scenario.id+'/draft');
 await expect(page.getByRole('heading',{name:'Подготовка карты',exact:true})).toBeVisible();
 await expect(page.getByLabel('A: роль игрока 1',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Применить роли A',exact:true})).toHaveCount(0);
 await page.getByText('Параметры карты и составы',{exact:true}).click();await page.getByText('Подтверждённые игроки и роли',{exact:true}).click();
 const roster=page.getByRole('region',{name:'Подтверждённый состав A',exact:true});
 await expect(roster.locator('li').first()).toContainText('Carry');
 await expect(roster.locator('li').first().locator('a')).toHaveAttribute('href','/players/'+base.lineupA[0]!.playerId);
 await page.getByRole('combobox',{name:'Radiant',exact:true}).selectOption('B');
 await page.getByRole('button',{name:'Сохранить карту',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Сценарий · редакция 2',exact:true})).toBeVisible();
 const snapshot=await (await page.request.get('/api/v1/scenarios/'+f.scenario.id)).json();
 expect(snapshot?.input.lineupA).toEqual(f.scenario.input.lineupA);expect(snapshot?.input.context.radiantSlot).toBe('B');
 expect(requests).toEqual([]);
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/map-workspace-mobile.png',fullPage:true});
});
