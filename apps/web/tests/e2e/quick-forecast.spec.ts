import {syntheticPlayerHistory} from '../../../../tests/helpers/player-history';
import {test,expect,type Page} from '@playwright/test';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {syntheticSchedule,syntheticRosters,scheduleToken} from '../../../../tests/helpers/upcoming';
import {syntheticCatalogue} from '../../../../tests/helpers/roster-catalogue';
import {sql,IdentityRepository,FreshPageScheduleTargetRepository,RosterCatalogueRepository,Tier1ScopeRepository} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string,cookie:string,csrf:string;
let ownerId:string;
let calls:string[],ambiguous:boolean,teamShift:number,historyAlias:boolean,partialTransfer:boolean;
const url='/api/v1/upcoming/70001/catalogue';
async function http(path:string,payload?:unknown){
 const response=await fetch('http://127.0.0.1:3151'+path,{method:payload===undefined?'GET':'POST',headers:{cookie,origin:'http://127.0.0.1:5179','x-csrf-token':csrf,'content-type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
 const body=await response.text();return {statusCode:response.status,body,json:()=>JSON.parse(body)};
}
const post=(path:string,payload:unknown)=>http(path,payload);
test.beforeEach(async()=>{
 database=await testDatabase();password=randomBytes(24).toString('base64url');calls=[];ambiguous=false;teamShift=0;historyAlias=false;partialTransfer=false;
 ownerId=(await new AuthService(database.db).provision('synthetic-auto-roster',password)).id;
 const fixture=syntheticCatalogue(),players=fixture.players.map((p,i)=>({...p,name:`Synthetic Player ${String(i+1).padStart(2,'0')}`}));
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',PANDASCORE_API_TOKEN:scheduleToken}),{
  db:database.db,logger:false,playerHistoryProvider:()=>syntheticPlayerHistory({mode:'empty'}),catalogueProvider:async key=>{
   calls.push(key);if(key!=='registry')throw Error('Unexpected external search in automatic preparation');
   const rawBody=JSON.stringify(players.map((p,i)=>({...p,name:ambiguous&&(i===0||i===6)?'Synthetic Twin':p.name})));
   return {rawBody,source:{endpoint:'/proPlayers',fetchedAt:new Date().toISOString(),payloadSha256:createHash('sha256').update(rawBody).digest('hex')}};
  },pandascoreFetch:async source=>{
   if(!source.pathname.endsWith('/rosters')){const s=syntheticSchedule();s[0]!.opponents[1]!.opponent.id+=teamShift;return Response.json(s);}
   const r=syntheticRosters();r.rosters[1]!.id+=teamShift;if(partialTransfer)r.rosters[1]!.players[4]!.id+=1000;
   r.rosters.forEach((t,i)=>t.players.forEach((p,j)=>{const n=i*6+j;p.name=historyAlias&&n===0?'Synthetic disputed history':ambiguous&&(n===0||n===6)?'Synthetic Twin':players[n]!.name;}));return Response.json(r);
  }});
 await api.listen({host:'127.0.0.1',port:3151});
 const login=await fetch('http://127.0.0.1:3151/api/v1/auth/login',{method:'POST',headers:{origin:'http://127.0.0.1:5179','content-type':'application/json'},body:JSON.stringify({login:'synthetic-auto-roster',password})});
 cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');csrf=(await login.json()).csrfToken;
 await post('/api/v1/upcoming/refresh',{});await post('/api/v1/upcoming/tournaments/71001/refresh',{});
});
test.afterEach(async({page})=>{await page.goto('about:blank');await api?.close();await database?.close();});
async function open(page:Page){
 await page.goto('/upcoming');await page.getByLabel('Логин').fill('synthetic-auto-roster');await page.getByLabel('Пароль').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByRole('link',{name:'Предстоящие матчи →'}).click();await page.getByRole('button',{name:'Выбрать',exact:true}).click();
}
const card=(page:Page,slot:string)=>page.getByRole('article',{name:'Выбранный состав '+slot,exact:true});

async function chooseFive(page:Page){
 await open(page);await expect(card(page,'B')).toContainText('Steam32 1007');
 for(let i=1;i<=5;i++)await card(page,'A').getByLabel(`Synthetic Player ${String(i).padStart(2,'0')} — в пятёрку A`,{exact:true}).check();
}
const confirm=(page:Page)=>page.getByRole('button',{name:'Подтвердить пятёрки и роли',exact:true});
const role=(page:Page,slot:string,index=1)=>card(page,slot).getByRole('combobox',{name:`${slot}: роль игрока ${index}`,exact:true});


async function prepare(page:Page,mapping=true,openMap=true){
 await chooseFive(page);await confirm(page).click();await expect(confirm(page)).toHaveAttribute('aria-pressed','true');
 await expect(page.getByRole('region',{name:'Прогноз всей встречи',exact:true})).toContainText('Модель победителя встречи ещё не прошла независимую проверку');
 if(openMap)await page.getByText('Отдельный прогноз первой карты',{exact:true}).click();
 await sql`INSERT INTO leagues(id,opendota_league_id,name) VALUES(77,777,'Synthetic Quick Event')`.execute(database.db);
 const scope={provider:'opendota' as const,leagueId:'777',eventName:'Synthetic Quick Event',fromAt:new Date(Date.now()-86400000).toISOString(),until:new Date(Date.now()+3*86400000).toISOString(),tier:1 as const,stage:'main_event' as const,sourceUrl:'https://example.test/synthetic-quick',rationale:'Synthetic owner-reviewed event for automatic forecast tests'};
 const stored=await new Tier1ScopeRepository(database.db).write(ownerId,{requestId:randomUUID(),scopeId:randomUUID(),expectedRevision:0,enabled:true,scope});
 if(mapping){const targets=new FreshPageScheduleTargetRepository(database.db),p=await targets.preview('70001'),bindings=new RosterCatalogueRepository(database.db);
 const a=await bindings.latest(ownerId,'74001'),b=await bindings.latest(ownerId,'74002');
 await targets.create(ownerId,{requestId:randomUUID(),providerMatchId:'70001',observationId:p.observation.id,observationSha256:p.observation.snapshotSha256,expectedRevision:0,mapNumber:1,
 providerTeamAId:'74001',providerTeamBId:'74002',teamAId:a!.teamId,teamBId:b!.teamId,leagueId:'77',reviewSourceUrl:scope.sourceUrl,reason:scope.rationale});}
 return stored;
}
const quick=(page:Page)=>page.getByRole('region',{name:'Прогноз выбранной встречи',exact:true});
const getForecast=(page:Page)=>quick(page).getByRole('button',{name:'Получить прогноз первой карты',exact:true});
test('whole-meeting mode is explicit and cannot silently create a first-map forecast',async({page})=>{
 await page.route('**/upcoming/70001/series-forecast/readiness',async route=>{
  const response=await route.fetch(),data=await response.json();
  await route.fulfill({response,json:{...data,reasons:['SCHEDULE_SOURCE_STALE',...data.reasons]}});
 });
 await prepare(page,true,false);
 const series=page.getByRole('region',{name:'Прогноз всей встречи',exact:true});
 await expect(series.getByRole('heading',{name:'Победитель встречи · BO3',exact:true})).toBeVisible();
 await expect(series.getByRole('status')).toContainText('Прогноз серии пока недоступен.');
 await expect(series.getByText('Расписание устарело. Обновите список встреч.')).toBeVisible();
 await expect(getForecast(page)).toBeHidden();
 expect((await sql`SELECT 1 FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
 expect((await sql`SELECT 1 FROM upcoming_forecast_preparations`.execute(database.db)).rows).toHaveLength(0);
 await quick(page).screenshot({path:'.tools/s309-series-desktop.png'});
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await quick(page).screenshot({path:'.tools/s309-series-mobile.png'});
});
test('one click prepares the map and displays the result in the selected meeting; reload only reads',async({page})=>{
 await prepare(page);let writes=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/70001/forecast'))writes++;});
 await getForecast(page).click();await expect(quick(page).getByRole('article',{name:'Сохранённый расчёт',exact:true})).toContainText('Нет активной проверенной модели');
 expect(page.url()).toContain('/upcoming');expect(writes).toBe(1);
 await expect(quick(page).getByRole('region',{name:'Сохранённый состав A',exact:true})).toHaveCount(0);
 await quick(page).getByText('Команды и ожидаемые составы A/B',{exact:true}).click();await expect(quick(page).getByRole('region',{name:'Сохранённый состав A',exact:true})).toBeVisible();
 await quick(page).getByText('Команды и ожидаемые составы A/B',{exact:true}).click();
 await expect(quick(page).getByRole('link',{name:'Открыть драфт этой карты →',exact:true})).toBeVisible();
 expect((await sql`SELECT * FROM upcoming_forecast_preparations`.execute(database.db)).rows).toHaveLength(1);
 await quick(page).screenshot({path:'test-results/quick-forecast-desktop.png'});
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await quick(page).screenshot({path:'test-results/quick-forecast-mobile.png'});
 await page.reload();await page.getByRole('button',{name:'Выбрать',exact:true}).click();
 await expect(quick(page).getByRole('article',{name:'Сохранённый расчёт',exact:true})).toBeVisible();expect(writes).toBe(1);
 await quick(page).getByRole('link',{name:'Открыть журнал прогнозов →',exact:true}).click();
 await expect(page.getByRole('region',{name:'Текущие прогнозы',exact:true})).toContainText('Прогноз не выдан');
 expect((await sql`SELECT 1 FROM v1_journal_reports`.execute(database.db)).rows).toHaveLength(0);
});
test('lost response retries the same request and does not create duplicate maps or predictions',async({page})=>{
 await prepare(page);const bodies:string[]=[];
 await page.route('**/api/v1/upcoming/70001/forecast',async route=>{bodies.push(route.request().postData()!);if(bodies.length===1){await route.fetch();await route.abort('failed');}else await route.continue();});
 await getForecast(page).click();await expect(quick(page).getByRole('alert')).toContainText('Ответ не получен');
 await quick(page).getByRole('button',{name:'Повторить получение прогноза',exact:true}).click();
 await expect(quick(page).getByRole('article',{name:'Сохранённый расчёт',exact:true})).toBeVisible();expect(bodies).toHaveLength(2);expect(bodies[0]).toBe(bodies[1]);
 for(const table of ['scenarios','upcoming_forecast_preparations','v1_runtime_snapshots'])expect((await sql`SELECT 1 FROM ${sql.table(table)}`.execute(database.db)).rows).toHaveLength(1);
});
test('unclassified tournament calculates after reload without roster or Tier 1 confirmation',async({page})=>{
 await chooseFive(page);await confirm(page).click();await expect(confirm(page)).toHaveAttribute('aria-pressed','true');
 await page.reload();await page.getByRole('button',{name:'Выбрать',exact:true}).click();
 await page.getByText('Отдельный прогноз первой карты',{exact:true}).click();
 await expect(getForecast(page)).toBeEnabled();await getForecast(page).click();
 await expect(quick(page).getByRole('article',{name:'Сохранённый расчёт',exact:true})).toContainText('Нет активной проверенной модели');
 await expect(quick(page).getByRole('heading',{name:'Однократная настройка турнира'})).toHaveCount(0);
 expect((await sql`SELECT 1 FROM scenarios`.execute(database.db)).rows).toHaveLength(1);
 expect((await sql`SELECT 1 FROM owner_tier1_scopes`.execute(database.db)).rows).toHaveLength(0);
});


test('real server stages show analysis while runtime waits; polling stops after completion',async({page})=>{
 await prepare(page);let release:()=>void=()=>{},locked:()=>void=()=>{},transaction:Promise<unknown>|undefined;
 const entered=new Promise<void>(r=>locked=r),gate=new Promise<void>(r=>release=r);let reads=0;
 page.on('request',r=>{if(r.url().includes('/forecast-progress/'))reads++;});
 await page.route('**/api/v1/upcoming/70001/forecast',async route=>{
  const id=route.request().postDataJSON().requestId;
  transaction=database.db.transaction().execute(async tx=>{
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'v1-runtime:'+ownerId+':'+id},0))`.execute(tx);locked();await gate;
  });
  await entered;await route.continue();
 });
 try{
  await getForecast(page).click();await entered;
  const progress=quick(page).getByRole('region',{name:'Ход расчёта',exact:true});
  await expect(progress.getByRole('status')).toContainText('Анализ pro-истории, расчёт и сохранение');
  await expect(progress.getByRole('progressbar')).toHaveAttribute('value','4');
  await expect(quick(page).getByRole('button',{name:'Подготавливаем карту и рассчитываем…',exact:true})).toBeDisabled();
  await progress.screenshot({path:'test-results/forecast-progress-desktop.png'});
  await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await progress.screenshot({path:'test-results/forecast-progress-mobile.png'});
  release();await transaction;
  await expect(progress.getByRole('status')).toContainText('Результат сохранён');
  await expect(progress.getByRole('progressbar')).toHaveAttribute('value','5');
  await expect(quick(page).getByRole('article',{name:'Сохранённый расчёт',exact:true})).toBeVisible();
  const stopped=reads;await page.waitForTimeout(1200);expect(reads).toBe(stopped);
 }finally{release();await transaction;}
});
