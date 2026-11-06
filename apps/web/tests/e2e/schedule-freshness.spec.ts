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
let base:Awaited<ReturnType<typeof seedPredictionScenario>>,match:ReturnType<typeof syntheticTargetMatch>,targetId:string,scenarioId:string;
let calls=0,failure=false,omit=false,counter=0;
test.beforeAll(async()=>{
  database=await testDatabase();base=await seedPredictionScenario(database.db);password=randomBytes(24).toString('base64url');
  owner=(await new AuthService(database.db).provision('synthetic-freshness-browser',password)).id;
  api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',PANDASCORE_API_TOKEN:'synthetic-freshness-token'}),
    {db:database.db,logger:false,pandascoreFetch:async()=>{
      calls++;return new Response(JSON.stringify(failure?{error:'synthetic failure'}:omit?[]:[{id:match.providerMatchId,name:match.name,status:match.status,
        scheduled_at:match.scheduledAt,tournament:{id:match.tournament.providerTournamentId,name:match.tournament.name},
        league:{id:match.league.providerLeagueId,name:match.league.name},number_of_games:3,
        opponents:match.opponents.map(t=>({type:'Team',opponent:{id:t.providerTeamId,name:t.name}}))}]),{status:failure?403:200});
    }});
  await api.listen({host:'127.0.0.1',port:3151});
});
test.beforeEach(async({page})=>{
  counter++;calls=0;failure=false;omit=false;
  match=syntheticTargetMatch({providerMatchId:String(70000+counter),scheduledAt:base.scheduledAt});
  await publishTargetSchedule(database.db,[match]);
  const repo=new V1ScheduleTargetRepository(database.db),p=await repo.preview(match.providerMatchId);
  const target=await repo.create(owner,{requestId:randomUUID(),providerMatchId:match.providerMatchId,observationId:p.observation.id,
    observationSha256:p.observation.snapshotSha256,expectedRevision:0,mapNumber:1,providerTeamAId:'74',providerTeamBId:'75',teamAId:'11',teamBId:'22',leagueId:'77',
    reviewSourceUrl:'https://example.test/synthetic-freshness',reason:'Synthetic reviewed browser schedule fixture'});
  targetId=target.record.request.requestId;
  scenarioId=(await new ScenarioRepository(database.db).save(owner,{...base,context:{...base.context,mapNumber:1}})).id;
  await publishTargetSchedule(database.db,[match],new Date(Date.now()-301000).toISOString());
  await sql`UPDATE upcoming_source_cache SET expires_at=clock_timestamp()-interval '1 second',retry_at='-infinity' WHERE cache_key='schedule'`.execute(database.db);
  await sql`UPDATE pandascore_request_quota SET next_request_at='-infinity',blocked_until='-infinity',requests_used=0`.execute(database.db);
  await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-freshness-browser');await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();
  await page.goto('/schedule-targets/'+targetId);await page.getByLabel('Сохранённый сценарий',{exact:true}).selectOption(scenarioId);
});
test.afterAll(async()=>{await api?.close();await database?.close();});
test('stale forecast is disabled, one bounded refresh restores admission and retains selected five',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const fresh=page.getByRole('region',{name:'Свежесть расписания'}),calculate=page.getByRole('button',{name:'Рассчитать назначенную карту',exact:true});
  await expect(fresh).toContainText('старше 5 минут');await expect(calculate).toBeDisabled();expect(calls).toBe(0);
  await fresh.getByRole('button',{name:'Обновить расписание перед прогнозом',exact:true}).click();
  await expect(fresh).toContainText('Расписание актуально');await expect(calculate).toBeEnabled();expect(calls).toBe(1);
  await expect(page.getByLabel('Сохранённый сценарий',{exact:true})).toHaveValue(scenarioId);
  await expect(fresh.getByRole('button')).toBeDisabled();
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/schedule-freshness-mobile.png',fullPage:true});
  await calculate.click();await expect(page.getByRole('article',{name:'Сохранённый расчёт',exact:true})).toContainText('Нет активной проверенной модели');
  expect(errors).toEqual([]);
});
test('failed refresh remains stale and cooldown survives reload without extra provider calls',async({page})=>{
  failure=true;const fresh=page.getByRole('region',{name:'Свежесть расписания'});
  await fresh.getByRole('button',{name:'Обновить расписание перед прогнозом',exact:true}).click();
  await expect(fresh).toContainText('Источник временно недоступен');await expect(fresh).toContainText('Следующее обновление доступно после');
  await expect(fresh.getByRole('button')).toBeDisabled();expect(calls).toBe(1);
  await page.reload();await expect(fresh).toContainText('старше 5 минут');await expect(fresh.getByRole('button')).toBeDisabled();expect(calls).toBe(1);
  await expect(page.getByRole('button',{name:'Рассчитать назначенную карту',exact:true})).toBeDisabled();
  expect((await sql`SELECT 1 FROM v1_runtime_snapshots WHERE schedule_target_request_id=${targetId}::uuid`.execute(database.db)).rows).toHaveLength(0);
});
test('a successful page omitting the selected meeting does not renew its old observation',async({page})=>{
  omit=true;const fresh=page.getByRole('region',{name:'Свежесть расписания'});
  await fresh.getByRole('button',{name:'Обновить расписание перед прогнозом',exact:true}).click();
  await expect(fresh).toContainText('В более новых страницах встречи нет');await expect(fresh).toContainText('старше 5 минут');
  await expect(page.getByRole('button',{name:'Рассчитать назначенную карту',exact:true})).toBeDisabled();expect(calls).toBe(1);
});
test('an open page expires admission using elapsed time without automatic provider requests',async({page})=>{
  await page.clock.install();await publishTargetSchedule(database.db,[match]);await page.reload();
  await page.getByLabel('Сохранённый сценарий',{exact:true}).selectOption(scenarioId);
  const calculate=page.getByRole('button',{name:'Рассчитать назначенную карту',exact:true});await expect(calculate).toBeEnabled();
  await page.clock.fastForward(301000);
  await expect(page.getByRole('region',{name:'Свежесть расписания'})).toContainText('старше 5 минут');await expect(calculate).toBeDisabled();
  expect(calls).toBe(0);
});
