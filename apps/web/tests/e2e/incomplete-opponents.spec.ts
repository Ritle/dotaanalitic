import {test,expect,type Page} from '@playwright/test';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedTargetCatalog,publishTargetSchedule,syntheticTargetMatch} from '../../../../tests/helpers/schedule-target';
import {sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,source:Awaited<ReturnType<typeof publishTargetSchedule>>,csrf:string,providerCalls=0;
const known={providerTeamId:'74',name:'Синтетический CyberHero'},rival={providerTeamId:'75',name:'Синтетический соперник'};
const one=()=>syntheticTargetMatch({providerMatchId:'1756311',name:'Synthetic CH vs TBD',scheduledAt:'2099-11-04T16:00:00.000Z',opponents:[known]});
const rows=()=>[one(),syntheticTargetMatch({providerMatchId:'2',name:'Synthetic stale A vs B',opponents:[]}),
 syntheticTargetMatch({providerMatchId:'3',opponents:[{...known,name:null},{...rival,name:null}]})];
const panel=(page:Page)=>page.getByRole('region',{name:'Ожидаемые составы',exact:true});
test.beforeEach(async({page})=>{
 database=await testDatabase();await seedTargetCatalog(database.db);source=await publishTargetSchedule(database.db,rows());providerCalls=0;
 await sql`INSERT INTO upcoming_source_cache(cache_key,payload,expires_at) VALUES('tournament:71',${JSON.stringify({data:[{providerTeamId:'74',name:known.name,players:[]},
   {providerTeamId:'75',name:'Synthetic roster-only team',players:[]}],source:{...source.snapshot.source,endpoint:'/tournaments/71/rosters'}})}::jsonb,clock_timestamp()+interval '5 minutes')`.execute(database.db);
 const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-incomplete-owner',password);
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',PANDASCORE_API_TOKEN:'synthetic-incomplete-token'}),
  {db:database.db,logger:false,catalogueProvider:async()=>{throw Error('Synthetic catalogue unavailable');},pandascoreFetch:async()=>{providerCalls++;throw Error('Unexpected provider call');}});await api.listen({host:'127.0.0.1',port:3151});
 await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-incomplete-owner');await page.getByLabel('Пароль').fill(password);
 const [login]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/auth/login')),page.getByRole('button',{name:'Войти',exact:true}).click()]);csrf=(await login.json()).csrfToken;
 await page.getByRole('link',{name:'Предстоящие матчи →',exact:true}).click();
});
test.afterEach(async()=>{await api?.close();await database?.close();});
async function pick(page:Page,label:string,id:string){const p=page.getByRole('region',{name:label,exact:true});await p.getByRole('searchbox').fill(id);await p.getByRole('searchbox').press('Enter');await p.getByRole('button',{name:new RegExp(' · ID '+id+'$')}).click();}
async function noSavedTargets(){for(const table of ['scenarios','prediction_runs','v1_schedule_targets'])expect((await sql`SELECT 1 FROM ${sql.table(table)}`.execute(database.db)).rows).toHaveLength(0);expect(providerCalls).toBe(0);}
test('one opponent is explicit, unrelated tournament roster is not a rival, target and provider-role prefill stay blocked',async({page})=>{
 const row=page.getByRole('row').filter({hasText:'Синтетический CyberHero — Соперник не указан'});await expect(row).toHaveCount(1);
 await row.getByRole('button',{name:'Выбрать',exact:true}).click();
 await expect(panel(page).getByText('В источнике указана только одна команда. Соперник не указан.',{exact:true})).toBeVisible();
 await expect(panel(page).getByRole('heading',{name:'Известный участник · Синтетический CyberHero',exact:true})).toBeVisible();
 await expect(panel(page).getByRole('heading',{name:'Соперник не указан',exact:true})).toBeVisible();
 await expect(panel(page).getByText('Synthetic roster-only team',{exact:true})).toHaveCount(0);
 await panel(page).getByText('Зафиксировать назначение первой карты',{exact:true}).click();
 await expect(panel(page).getByRole('button',{name:'Сохранить назначение карты 1',exact:true})).toBeDisabled();
 await expect(panel(page).getByText('Участник B: не выбран.',{exact:true})).toBeVisible();
 const preview=await (await page.request.get('/api/v1/upcoming/1756311/target-preview')).json();expect(preview.eligible).toBe(false);expect(preview.reasons).toContain('SCHEDULE_OPPONENTS_INCOMPLETE');
 const forged=await page.request.post('/api/v1/schedule-targets',{headers:{origin:'http://127.0.0.1:5179','x-csrf-token':csrf},data:{requestId:randomUUID(),providerMatchId:'1756311',
  observationId:preview.observation.id,observationSha256:preview.observation.snapshotSha256,expectedRevision:0,mapNumber:1,providerTeamAId:'74',providerTeamBId:'75',teamAId:'11',teamBId:'22',leagueId:'77',
  reviewSourceUrl:'https://example.test/synthetic',reason:'Synthetic attempted missing opponent substitution'}});
 expect(forged.status()).toBe(409);
 await panel(page).getByText('Выбрать игроков для анализа одной карты',{exact:true}).click();await pick(page,'Команда A в локальной базе','11');
 await expect(panel(page).getByText('Это гипотетический сценарий',{exact:false})).toBeVisible();
 const roles=panel(page).getByRole('region',{name:'Автоопределение ролей A',exact:true});await roles.getByText('Сопоставление источников A',{exact:true}).click();
 await expect(roles.getByLabel('ID команды PandaScore A',{exact:true})).toHaveValue('');
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/incomplete-opponent-mobile.png',fullPage:true});await noSavedTargets();
});
test('zero participants ignores stale match name; unnamed teams with two IDs are not missing opponents',async({page})=>{
 const empty=page.getByRole('row').filter({hasText:'Участники не указаны'});await expect(empty).toHaveCount(1);await empty.getByRole('button',{name:'Выбрать',exact:true}).click();
 await expect(panel(page).getByText('В источнике пока не указаны обе команды.',{exact:true})).toBeVisible();
 const two=page.getByRole('row').filter({hasText:'Команда PandaScore #74 — Команда PandaScore #75'});await two.getByRole('button',{name:'Выбрать',exact:true}).click();
 await panel(page).getByText('Заявка турнира и участники источника',{exact:true}).click();
 await expect(panel(page).getByRole('heading',{name:'Команда A · Команда PandaScore #74',exact:true})).toBeVisible();
 await expect(panel(page).getByRole('heading',{name:'Соперник не указан',exact:true})).toHaveCount(0);await noSavedTargets();
});
test('same match gains or loses opponent: source refresh resets old manual choice and target confirmation',async({page})=>{
 await page.getByRole('row').filter({hasText:known.name}).getByRole('button',{name:'Выбрать',exact:true}).click();
 await panel(page).getByText('Выбрать игроков для анализа одной карты',{exact:true}).click();await pick(page,'Команда A в локальной базе','11');
 await page.getByLabel('Подтверждаю выбранных игроков и роли для одной карты',{exact:true}).check();
 await publishTargetSchedule(database.db,[{...one(),opponents:[known,rival]}]);await page.getByRole('button',{name:'Обновить расписание',exact:true}).click();
 await expect(page.getByRole('row').filter({hasText:'Синтетический CyberHero — Синтетический соперник'})).toHaveCount(1);
 await panel(page).getByText('Выбрать игроков для анализа одной карты',{exact:true}).click();
 await expect(page.getByLabel('Подтверждаю выбранных игроков и роли для одной карты',{exact:true})).not.toBeChecked();
 await expect(page.getByRole('region',{name:'Команда A в локальной базе',exact:true}).getByText(/^Выбрано:/)).toHaveCount(0);
 await panel(page).getByText('Зафиксировать назначение первой карты',{exact:true}).click();
 const confirmation=page.getByLabel('Подтверждаю соответствие участников и назначение карты 1',{exact:true});await expect(confirmation).toBeEnabled();await confirmation.check();
 await publishTargetSchedule(database.db,[one()]);await page.getByRole('button',{name:'Обновить расписание',exact:true}).click();
 await expect(panel(page).getByText('В источнике указана только одна команда. Соперник не указан.',{exact:true})).toBeVisible();
 await panel(page).getByText('Зафиксировать назначение первой карты',{exact:true}).click();
 await expect(page.getByLabel('Подтверждаю соответствие участников и назначение карты 1',{exact:true})).not.toBeChecked();
 await expect(panel(page).getByRole('button',{name:'Сохранить назначение карты 1',exact:true})).toBeDisabled();
 await noSavedTargets();
});
