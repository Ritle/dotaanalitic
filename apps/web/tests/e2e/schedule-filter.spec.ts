import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {UpcomingMatch} from '../../../../packages/contracts/src/index';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedTargetCatalog,publishTargetSchedule,syntheticTargetMatch} from '../../../../tests/helpers/schedule-target';
import {sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
const eventA='9007199254740992',eventB='9007199254740993',eventPast='77',eventUnknown='79';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,providerCalls:number;
let snapshot:Awaited<ReturnType<typeof publishTargetSchedule>>;
const filter=(page:Page)=>page.getByLabel('Турнир в сохранённом расписании',{exact:true});
const panel=(page:Page)=>page.getByRole('region',{name:'Ожидаемые составы',exact:true});
function match(id:string,event:string,label:string,extra:Partial<UpcomingMatch>={}):UpcomingMatch{
 return syntheticTargetMatch({providerMatchId:id,name:label,scheduledAt:'2099-01-02T00:00:00.000Z',
  tournament:{providerTournamentId:event,name:'Synthetic shared stage'},league:{providerLeagueId:'72',name:'Synthetic shared league '+('длинное название '.repeat(8))},
  opponents:[{providerTeamId:'74',name:label},{providerTeamId:'75',name:'Synthetic rival'}],...extra});
}
const rows=()=>[match('1001',eventA,'Synthetic A1'),match('1002',eventA,'Synthetic A2',{scheduledAt:null}),
 match('1003',eventB,'Synthetic B1'),match('1004',eventPast,'Synthetic past',{scheduledAt:'2020-01-01T00:00:00.000Z'}),
 match('1005',eventA,'Synthetic running',{status:'running'}),match('1006',eventUnknown,'Synthetic unnamed',{
  tournament:{providerTournamentId:eventUnknown,name:null},league:{providerLeagueId:'73',name:null}})];
test.beforeEach(async({page})=>{
 database=await testDatabase();await seedTargetCatalog(database.db);snapshot=await publishTargetSchedule(database.db,rows());providerCalls=0;
 const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-filter-browser',password);
 for(const [id,name] of [[eventA,'Synthetic A-only-player'],[eventB,'Synthetic B-only-player']]){
  const payload={data:[{providerTeamId:'74',name:'Synthetic team',players:[{providerPlayerId:'100',name}]}],source:{...snapshot.snapshot.source,
   endpoint:`/tournaments/${id}/rosters`}};
  await sql`INSERT INTO upcoming_source_cache(cache_key,payload,expires_at) VALUES(${'tournament:'+id},${JSON.stringify(payload)}::jsonb,clock_timestamp()+interval '5 minutes')`.execute(database.db);
 }
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',PANDASCORE_API_TOKEN:'synthetic-filter-token'}),
  {db:database.db,logger:false,catalogueProvider:async()=>{throw Error('Synthetic catalogue unavailable');},pandascoreFetch:async()=>{providerCalls++;throw Error('Unexpected synthetic provider request');}});
 await api.listen({host:'127.0.0.1',port:3151});await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-filter-browser');await page.getByLabel('Пароль').fill(password);
 await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('link',{name:'Предстоящие матчи →',exact:true}).click();
 await expect(filter(page)).toBeEnabled();
});
test.afterEach(async()=>{await api?.close();await database?.close();});
async function unchanged(){
 const stored=(await sql<{snapshot_sha256:string}>`SELECT snapshot_sha256 FROM upcoming_source_observations WHERE id=${snapshot.id}::bigint`.execute(database.db)).rows[0];
 expect(stored?.snapshot_sha256).toBe(snapshot.sha);expect(providerCalls).toBe(0);
 for(const table of ['scenarios','prediction_runs','v1_schedule_targets'])expect((await sql`SELECT 1 FROM ${sql.table(table)}`.execute(database.db)).rows).toHaveLength(0);
}
test('filters by distinct BIGINT provider IDs despite identical names, preserves unknown time and reports bounded counts',async({page})=>{
 await expect(page.getByText(/В ответе: 6 · Предстоящих на странице: 4 · Показано: 4/)).toBeVisible();
 await expect(filter(page).locator(`option[value="${eventA}"]`)).toHaveCount(1);await expect(filter(page).locator(`option[value="${eventB}"]`)).toHaveCount(1);
 await filter(page).selectOption(eventA);await expect(page.getByRole('button',{name:'Выбрать',exact:true})).toHaveCount(2);
 await expect(filter(page).locator('option:checked')).toHaveText(new RegExp(`^PandaScore #${eventA} · `));
 await expect(page.getByText(`Выбранный турнир: PandaScore #${eventA}.`,{exact:true})).toBeVisible();
 await expect(page.getByRole('row').filter({hasText:'Synthetic B1'})).toHaveCount(0);await expect(page.getByText('Время не объявлено',{exact:true})).toBeVisible();
 await expect(page.getByText(/Предстоящих на странице: 4 · Показано: 2/)).toBeVisible();
 await page.screenshot({path:'test-results/schedule-filter-desktop.png',fullPage:true});
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/schedule-filter-mobile.png',fullPage:true});
 await filter(page).selectOption(eventB);await expect(page.getByRole('button',{name:'Выбрать',exact:true})).toHaveCount(1);
 await expect(page.getByRole('row').filter({hasText:'Synthetic B1'})).toBeVisible();
 await filter(page).selectOption(eventUnknown);await expect(page.getByRole('row').filter({hasText:'Synthetic unnamed'})).toBeVisible();
 await expect(filter(page).locator('option:checked')).toContainText('Турнир без названия');
 await filter(page).selectOption(eventPast);await expect(page.getByText('На этой странице нет предстоящих встреч выбранного турнира.',{exact:false})).toBeVisible();
 await expect(page.getByRole('button',{name:'Выбрать',exact:true})).toHaveCount(0);await expect(page.getByText(/не на полный календарь/)).toBeVisible();
 await filter(page).selectOption('');await expect(page.getByRole('button',{name:'Выбрать',exact:true})).toHaveCount(4);await unchanged();
});
test('changing event clears the selected meeting and unsaved confirmation even if the same meeting is selected again',async({page})=>{
 await filter(page).selectOption(eventA);await page.getByRole('button',{name:'Выбрать',exact:true}).first().click();
 await panel(page).getByText('Выбрать игроков для анализа одной карты',{exact:true}).click();
 await panel(page).getByRole('searchbox',{name:'Команда A в локальной базе',exact:true}).fill('unsaved choice');
 await page.getByLabel('Подтверждаю выбранных игроков и роли для одной карты',{exact:true}).check();
 await filter(page).selectOption(eventB);await expect(panel(page)).toHaveCount(0);
 await filter(page).selectOption(eventA);await expect(panel(page)).toHaveCount(0);await page.getByRole('button',{name:'Выбрать',exact:true}).first().click();
 await panel(page).getByText('Выбрать игроков для анализа одной карты',{exact:true}).click();
 await expect(page.getByLabel('Подтверждаю выбранных игроков и роли для одной карты',{exact:true})).not.toBeChecked();
 await expect(panel(page).getByRole('searchbox',{name:'Команда A в локальной базе',exact:true})).toHaveValue('');await unchanged();
});
test('a late roster response for the former event cannot replace the newly selected event',async({page})=>{
 let release:()=>void=()=>{},seen:()=>void=()=>{},finish:()=>void=()=>{};
 const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>seen=r),finished=new Promise<void>(r=>finish=r);
 await page.route(`**/api/v1/upcoming/tournaments/${eventA}`,async route=>{
  const response=await route.fetch();seen();await gate;await route.fulfill({response}).catch(()=>{}).finally(finish);
 });
 try{
  await filter(page).selectOption(eventA);await page.getByRole('button',{name:'Выбрать',exact:true}).first().click();await started;
  await filter(page).selectOption(eventB);await expect(panel(page)).toHaveCount(0);await page.getByRole('button',{name:'Выбрать',exact:true}).click();
  await expect(panel(page)).toContainText('Synthetic B-only-player');release();await finished;
  await expect(panel(page)).not.toContainText('Synthetic A-only-player');await expect(panel(page).getByRole('heading',{level:2})).toHaveText('Synthetic B1');
 }finally{release();}
 await unchanged();
});
test('cache refresh retains a missing event filter instead of silently showing all meetings and closes old selection',async({page})=>{
 await filter(page).selectOption(eventA);await page.getByRole('button',{name:'Выбрать',exact:true}).first().click();await expect(panel(page)).toBeVisible();
 // Simulate another capture publishing a new first page. The fresh cache makes POST read it without provider calls.
 await publishTargetSchedule(database.db,[rows()[2]!]);
 await page.getByRole('button',{name:'Обновить расписание',exact:true}).click();
 await expect(filter(page)).toHaveValue(eventA);await expect(filter(page).locator('option:checked')).toContainText('отсутствует на странице');
 await expect(page.getByText(/В ответе: 1 · Предстоящих на странице: 1 · Показано: 0/)).toBeVisible();await expect(panel(page)).toHaveCount(0);
 await expect(page.getByText('На этой странице нет предстоящих встреч выбранного турнира.',{exact:false})).toBeVisible();
 await filter(page).selectOption('');await expect(page.getByRole('row').filter({hasText:'Synthetic B1'})).toBeVisible();await unchanged();
});
