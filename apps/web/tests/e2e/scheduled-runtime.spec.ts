import {test,expect} from '@playwright/test';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedPredictionScenario} from '../../../../tests/helpers/predictions';
import {publishTargetSchedule,syntheticTargetMatch} from '../../../../tests/helpers/schedule-target';
import {ScenarioRepository,V1RuntimeRepository,V1JournalRepository,V1ScheduleTargetRepository} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
import {journalViewFixture} from '../../../../tests/helpers/journal-view';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string,owner:string,scenarioId:string;
test.beforeAll(async()=>{
  database=await testDatabase();const input=await seedPredictionScenario(database.db);password=randomBytes(24).toString('base64url');
  owner=(await new AuthService(database.db).provision('synthetic-scheduled-browser',password)).id;
  scenarioId=(await new ScenarioRepository(database.db).save(owner,input)).id;
  api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});
  await api.listen({host:'127.0.0.1',port:3151});
});
test.beforeEach(async({page})=>{
  await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-scheduled-browser');await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();
});
test.afterAll(async()=>{await api?.close();await database?.close();});

test('displays an explicitly synthetic reviewed schedule-result association without confusing it with an unknown result',async({page})=>{
  const fixture=journalViewFixture(),row=fixture.rows[0]!;
  row.target={provider:'pandascore',providerMatchId:'9007199254742999',mapNumber:1,targetRequestId:randomUUID(),targetSha256:'a'.repeat(64)};
  row.scheduleResultBinding={requestId:randomUUID(),sha256:'b'.repeat(64),targetRequestId:row.target.targetRequestId,targetSha256:row.target.targetSha256,
    providerMatchId:row.target.providerMatchId,providerSeriesId:'321',matchId:row.matchId!,reviewedAt:fixture.capturedAt,
    sourceUrl:'https://example.test/synthetic-cross-provider-proof',basis:'owner_reviewed_cross_provider_mapping'};
  await page.route('**/api/v1/forecast-journal/'+fixture.requestId+'?offset=*',route=>route.fulfill({json:fixture}));
  await page.goto('/forecast-journal?report='+fixture.requestId);
  const result=page.getByRole('row').filter({has:page.getByRole('link',{name:'Синтетический пример журнала',exact:true})});
  await result.getByText('Сведения о прогнозе',{exact:true}).click();
  await expect(result).toContainText('Сохранено ручное сопоставление с OpenDota series #321');
  await expect(result).toContainText('Проверено владельцем');await expect(result).not.toContainText('Связь с результатом карты ещё не подтверждена');
  await page.screenshot({path:'test-results/schedule-result-desktop.png',fullPage:true});
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await result.getByRole('link',{name:'Сохранённый выбор встречи →',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:'test-results/schedule-result-mobile.png',fullPage:true});
});
test('scheduled forecast keeps its provider identity, frozen lineup and target link in the real owner journal',async({page})=>{
  const scenarios=new ScenarioRepository(database.db),base=await scenarios.get(owner,scenarioId);
  const match=syntheticTargetMatch({scheduledAt:base.input.scheduledAt!});await publishTargetSchedule(database.db,[match]);
  const targets=new V1ScheduleTargetRepository(database.db),preview=await targets.preview(match.providerMatchId);
  const target=await targets.create(owner,{requestId:randomUUID(),providerMatchId:match.providerMatchId,observationId:preview.observation.id,
    observationSha256:preview.observation.snapshotSha256,expectedRevision:0,mapNumber:1,providerTeamAId:'74',providerTeamBId:'75',
    teamAId:'11',teamBId:'22',leagueId:'77',reviewSourceUrl:'https://example.test/synthetic-reviewed-event',reason:'Synthetic reviewed event and organization mapping'});
  const scenario=await scenarios.save(owner,{...base.input,title:'Синтетическая карта из расписания',context:{...base.input.context,mapNumber:1}});
  const forecast=await new V1RuntimeRepository(database.db).create(owner,{requestId:randomUUID(),scenarioId:scenario.id,expectedRevision:1,purpose:'real_map',targetScope:null,
    realTarget:{provider:'pandascore',bindingVersion:1,providerMatchId:match.providerMatchId,mapNumber:1,targetRequestId:target.record.request.requestId,targetSha256:target.sha256}});
  const report=await new V1JournalRepository(database.db).create(owner,{requestId:randomUUID(),filters:{}});
  await page.goto('/forecast-journal?report='+report.report.request.requestId);
  const row=page.getByRole('row').filter({has:page.getByRole('link',{name:'Синтетическая карта из расписания',exact:true})});
  await row.getByText('Сведения о прогнозе',{exact:true}).click();await expect(row).toContainText('PandaScore встреча #'+match.providerMatchId);
  await expect(row).toContainText('#101, #102, #103, #104, #105');await expect(row).not.toContainText('OpenDota series');
  await expect(row).toContainText('Связь с результатом карты ещё не подтверждена');await expect(row).toContainText('Расчёт недоступен');
  await page.screenshot({path:'test-results/scheduled-runtime-journal-desktop.png',fullPage:true});
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await row.getByRole('link',{name:'Сохранённый выбор встречи →',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:'test-results/scheduled-runtime-journal-mobile.png',fullPage:true});
  await row.getByRole('link',{name:'Сохранённый выбор встречи →',exact:true}).click();
  await expect(page.getByRole('article',{name:'Сохранённое назначение карты',exact:true})).toContainText(match.name!);
  expect(forecast.snapshot.teamAWinProbability).toBeNull();
});
