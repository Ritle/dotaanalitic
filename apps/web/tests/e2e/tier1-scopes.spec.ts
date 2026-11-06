import {test,expect,type Page} from '@playwright/test';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedPredictionScenario} from '../../../../tests/helpers/predictions';
import {publishTargetSchedule,syntheticTargetMatch} from '../../../../tests/helpers/schedule-target';
import {ScenarioRepository,Tier1ScopeRepository,V1ScheduleTargetRepository,sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,owner:string,password:string,id:string;
let input:Awaited<ReturnType<typeof seedPredictionScenario>>;
const scope={provider:'opendota' as const,leagueId:'77',eventName:'Synthetic saved event',fromAt:'2099-01-01T00:00:00.000Z',until:'2099-02-01T00:00:00.000Z',
 tier:1 as const,stage:'main_event' as const,sourceUrl:'https://example.test/synthetic-main',rationale:'Synthetic explicitly reviewed main event for browser tests'};
test.beforeAll(async()=>{
 database=await testDatabase();input=await seedPredictionScenario(database.db);password=randomBytes(24).toString('hex');
 owner=(await new AuthService(database.db).provision('synthetic-scope-browser',password)).id;
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179'}),{db:database.db,logger:false});await api.listen({host:'127.0.0.1',port:3151});
});
test.beforeEach(async({page})=>{
 id=(await new ScenarioRepository(database.db).save(owner,input)).id;
 await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-scope-browser');await page.getByLabel('Пароль').fill(password);
 await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();
});
test.afterAll(async()=>{await api?.close();await database?.close();});
async function fill(page:Page,name:string){
 await page.getByLabel('Сохранённый турнир Tier 1',{exact:true}).selectOption('new');
 await page.getByLabel('ID лиги OpenDota',{exact:true}).fill('77');await page.getByLabel('Название события',{exact:true}).fill(name);
 await page.getByLabel('Начало события UTC',{exact:true}).fill('2099-01-01T00:00');await page.getByLabel('Конец периода события UTC',{exact:true}).fill('2099-02-01T00:00');
 await page.getByLabel('Источник проверки · HTTPS',{exact:true}).fill(scope.sourceUrl);await page.getByLabel('Обоснование Tier 1',{exact:true}).fill(scope.rationale);
 await page.getByLabel('Я проверил, что карта относится к основному событию Tier 1',{exact:true}).check();
}
test('saves an owner-reviewed event once, reuses after reload and freezes full scope without activating a model',async({page})=>{
 await page.goto(`/scenarios/${id}/prediction`);await fill(page,scope.eventName);
 await page.getByRole('button',{name:'Сохранить событие для следующих матчей',exact:true}).click();
 const select=page.getByLabel('Сохранённый турнир Tier 1',{exact:true});await expect(select).not.toHaveValue('new');
 const scopeId=await select.inputValue();expect(scopeId).toMatch(/^[a-f0-9-]{36}$/);
 await expect(page.getByLabel('Я проверил, что карта относится к основному событию Tier 1',{exact:true})).toBeChecked();
 expect((await sql`SELECT * FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
 await page.reload();await select.selectOption(scopeId);
 await expect(page.getByLabel('ID лиги OpenDota',{exact:true})).toHaveCount(0);
 await expect(page.getByLabel('Я проверил, что карта относится к основному событию Tier 1',{exact:true})).not.toBeChecked();
 await page.getByLabel('Я проверил, что карта относится к основному событию Tier 1',{exact:true}).check();
 await page.getByRole('button',{name:'Рассчитать и сохранить попытку',exact:true}).click();
 await expect(page.getByRole('article',{name:'Сохранённый расчёт',exact:true})).toContainText('Нет активной проверенной модели');
 const row=(await sql<{scope:unknown;status:string;p:null}>`SELECT snapshot_text::jsonb#>'{request,targetScope}' scope,
  snapshot_text::jsonb->>'status' status,snapshot_text::jsonb->>'teamAWinProbability' p FROM v1_runtime_snapshots WHERE snapshot_text::jsonb#>>'{scenario,id}'=${id}`.execute(database.db)).rows[0]!;
 expect(row).toEqual({scope,status:'unavailable',p:null});
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('region',{name:'Событие Tier 1',exact:true}).screenshot({path:'test-results/tier1-scope-mobile.png'});
});
test('shares saved events with scheduled forecasts and hiding never changes the prior snapshot',async({page})=>{
 const entry=await new Tier1ScopeRepository(database.db).write(owner,{requestId:randomUUID(),scopeId:randomUUID(),expectedRevision:0,enabled:true,scope:{...scope,eventName:'Synthetic scheduled event'}});
 const scenario=await new ScenarioRepository(database.db).save(owner,{...input,context:{...input.context,mapNumber:1}});
 const match=syntheticTargetMatch({scheduledAt:input.scheduledAt});await publishTargetSchedule(database.db,[match]);
 const repo=new V1ScheduleTargetRepository(database.db),preview=await repo.preview(match.providerMatchId);
 const target=await repo.create(owner,{requestId:randomUUID(),providerMatchId:match.providerMatchId,observationId:preview.observation.id,observationSha256:preview.observation.snapshotSha256,
  expectedRevision:0,mapNumber:1,providerTeamAId:'74',providerTeamBId:'75',teamAId:'11',teamBId:'22',leagueId:'77',reviewSourceUrl:'https://example.test/synthetic-mapping',reason:'Synthetic explicit owner-reviewed organization mapping'});
 await page.goto('/schedule-targets/'+target.record.request.requestId);await page.getByLabel('Сохранённый сценарий',{exact:true}).selectOption(scenario.id);
 await page.getByLabel('Сохранённый турнир Tier 1',{exact:true}).selectOption(entry.record.request.scopeId);
 await page.getByLabel('Я проверил, что карта относится к основному событию Tier 1',{exact:true}).check();
 await page.getByRole('button',{name:'Рассчитать назначенную карту',exact:true}).click();
 await expect(page.getByRole('article',{name:'Сохранённый расчёт',exact:true})).toContainText('Нет активной проверенной модели');
 const before=(await sql`SELECT snapshot_text,snapshot_sha256 FROM v1_runtime_snapshots`.execute(database.db)).rows;
 await page.getByRole('button',{name:'Убрать из быстрого выбора',exact:true}).click();
 await expect(page.getByLabel('Сохранённый турнир Tier 1',{exact:true})).toHaveValue('');
 expect((await sql`SELECT snapshot_text,snapshot_sha256 FROM v1_runtime_snapshots`.execute(database.db)).rows).toEqual(before);
 await page.reload();await expect(page.getByLabel('Сохранённый турнир Tier 1',{exact:true}).getByRole('option',{name:/Synthetic scheduled event/})).toHaveCount(0);
 const stored=(await sql<{scope:unknown}>`SELECT snapshot_text::jsonb#>'{request,targetScope}' scope FROM v1_runtime_snapshots WHERE schedule_target_request_id=${target.record.request.requestId}`.execute(database.db)).rows[0]!;
 expect(stored.scope).toEqual(entry.record.request.scope);
});
test('lost catalogue POST response retries the frozen request instead of creating duplicate events',async({page})=>{
 await page.goto(`/scenarios/${id}/prediction`);await fill(page,'Synthetic lost response event');let requestId='';
 await page.route('**/api/v1/tier1-scopes',async route=>{
  if(route.request().method()!=='POST'||requestId)return route.continue();requestId=route.request().postDataJSON().requestId;
  await route.fetch();await route.abort('failed');
 });
 await page.getByRole('button',{name:'Сохранить событие для следующих матчей',exact:true}).click();
 await page.getByRole('button',{name:'Повторить сохранение события',exact:true}).click();
 await expect(page.getByLabel('Сохранённый турнир Tier 1',{exact:true})).not.toHaveValue('new');
 expect((await sql`SELECT * FROM owner_tier1_scopes WHERE request_id=${requestId}::uuid`.execute(database.db)).rows).toHaveLength(1);
 expect((await sql`SELECT * FROM prediction_runs WHERE scenario_id=${id}::uuid`.execute(database.db)).rows).toHaveLength(0);
});
