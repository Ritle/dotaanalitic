import {test,expect,type Page,type BrowserContext} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedProMaps} from '../../../../tests/helpers/pro-maps';
import {catalogPlayerId} from '../../../../tests/helpers/catalog';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,state:Awaited<ReturnType<BrowserContext['storageState']>>,providerCalls=0;
test.beforeAll(async({browser})=>{
 database=await testDatabase();await seedProMaps(database.db);const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-ranked-browser',password);
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',RANKED_PRACTICE_ENABLED:'true',STRATZ_API_TOKEN:'synthetic-ranked-key'}),{
  db:database.db,logger:false,rankedPracticeFetch:async(url,init)=>{providerCalls++;return new Response(JSON.stringify(String(url).includes('stratz')?{data:{player:{steamAccountId:JSON.parse(String(init?.body)).variables.account,matches:[]}}}:[]));}});
 await api.listen({host:'127.0.0.1',port:3151});const context=await browser.newContext(),page=await context.newPage();
 await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-ranked-browser');await page.getByLabel('Пароль').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();
 state=await context.storageState();await context.close();
});
test.beforeEach(async({context})=>{await context.addCookies(state.cookies);});
test.afterAll(async()=>{await api?.close();await database?.close();});
const panel=(page:Page)=>page.getByRole('region',{name:'Рейтинговая практика игрока',exact:true});
async function open(page:Page){await page.goto('/players/'+catalogPlayerId);await page.locator('.ranked-practice>summary').click();await expect(panel(page)).toBeVisible();}
function fixture(playerId:string,provider='opendota',extra:Record<string,unknown>={}){
 return {playerId,accountId:'1000',provider,snapshotAt:new Date().toISOString(),identityRevision:'10',observationIdentityRevision:null,identityStatus:'verified',status:'not_loaded',stale:false,reason:'not_loaded',retryAt:null,observationId:null,observation:null,statisticsEnabled:false,...extra};
}
function observed(){
 const cutoff=Math.floor(Date.now()/1000)*1000,at=(ms:number)=>new Date(ms).toISOString();
 return {adapterVersion:'ranked-practice-reader-v1',provider:'opendota',accountId:'1000',fromAt:at(cutoff-30*86400000),cutoffAt:at(cutoff),knownAt:null,fetchedAt:at(cutoff),filters:{lobbyTypeId:7,gameModeId:22,windowDays:30,qualityFilter:'none'},
  maps:[{matchId:'9999',accountId:'1000',heroId:'1',startedAt:at(cutoff-7200000),completedAt:at(cutoff-5400000),completionBasis:'start_plus_duration',side:'dire',win:true,patchCode:null,position:null,roleBasis:'unknown',averageRank:null,partySize:null}],
  coverage:{receivedRows:1,excluded:{},duplicates:0,conflicts:0,pagination:'exhausted',historyCompleteness:'unknown',stopReason:null},receipts:[{offset:0,rows:1,fetchedAt:at(cutoff),payloadSha256:'a'.repeat(64)}]};
}
test('synthetic raw hero table shows observed 0/100 percent, sample sizes and recency; scrolling stays inside mobile panel',async({page})=>{
 const o=observed(),first=o.maps[0]!;
 o.adapterVersion='ranked-practice-reader-v2';o.maps=[first,{...first,matchId:'10000',heroId:'2',win:false}];
 o.coverage={...o.coverage,receivedRows:2,pagination:'capped'};o.receipts=[{...o.receipts[0]!,rows:2}];
 const observationId='11111111-1111-4111-8111-111111111111',heroSummary={observationId,policyVersion:'ranked-hero-raw-v1',roleScope:'all_roles',weighted:false,games:2,wins:1,winRate:0.5,lastPlayedAt:first.startedAt,
  heroes:[{heroId:'1',heroName:'Synthetic winning hero',games:1,wins:1,winRate:1,lastPlayedAt:first.startedAt},{heroId:'2',heroName:null,games:1,wins:0,winRate:0,lastPlayedAt:first.startedAt}]};
 await page.route('**/api/v1/ranked-practice',async r=>{const p=r.request().postDataJSON();await r.fulfill({json:fixture(p.playerId,p.provider,{status:'partial',reason:null,observationIdentityRevision:'10',observationId,observation:o,statisticsEnabled:true,heroSummary})});});
 await open(page);const table=panel(page).getByRole('table');await expect(table.getByRole('row')).toHaveCount(3);
 await expect(table.getByRole('row',{name:/Synthetic winning hero/})).toContainText('100');await expect(table.getByRole('row',{name:/Герой ID 2/})).toContainText('0');
 await expect(panel(page)).toContainText('2 наблюдаемых игр · героев 2');await expect(panel(page)).toContainText('При малом числе игр');await expect(table.getByRole('columnheader',{name:'Последняя игра (UTC)'})).toBeVisible();
 await expect(panel(page)).not.toContainText('Показатели по героям этого источника пока недоступны.');
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const scroll=panel(page).getByRole('region',{name:'Таблица рейтинговой практики'});await scroll.focus();expect(await scroll.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);await page.keyboard.press('ArrowRight');await expect.poll(()=>scroll.evaluate(el=>el.scrollLeft)).toBeGreaterThan(0);
 await page.locator('.ranked-practice').screenshot({path:'test-results/ranked-hero-summary-mobile.png'});
});
test('collapsed panel makes no request; explicit refresh uses real negative cache and source switch remains read-only',async({page})=>{
 const requests:boolean[]=[];page.on('request',r=>{if(r.url().endsWith('/api/v1/ranked-practice'))requests.push(r.postDataJSON().refresh);});
 await page.goto('/players/'+catalogPlayerId);await expect(page.getByRole('heading',{name:'Герой и позиция',exact:true})).toBeVisible();expect(requests).toEqual([]);const before=providerCalls;
 await page.locator('.ranked-practice>summary').focus();await page.keyboard.press('Enter');await expect(panel(page)).toContainText('Рейтинговая история ещё не загружена.');expect(requests).toEqual([false]);expect(providerCalls).toBe(before);
 await panel(page).getByRole('button',{name:'Загрузить рейтинговую историю',exact:true}).click();await expect(panel(page)).toContainText('Данные рейтинговых игр за период не получены.');expect(providerCalls).toBe(before+1);
 await panel(page).getByRole('button',{name:'Обновить рейтинговую историю',exact:true}).click();await expect(panel(page).getByRole('button',{name:'Обновить рейтинговую историю',exact:true})).toBeEnabled();expect(providerCalls).toBe(before+1);
 await page.reload();await page.locator('.ranked-practice>summary').click();await expect(panel(page)).toContainText('Данные рейтинговых игр за период не получены.');expect(providerCalls).toBe(before+1);
 await panel(page).getByLabel('Источник рейтинговых игр').selectOption('stratz');await expect(panel(page)).toContainText('Рейтинговая история ещё не загружена.');expect(providerCalls).toBe(before+1);expect(requests.filter(Boolean)).toHaveLength(2);
});
test('synthetic capped sample exposes window/count/unknown coverage, never a win rate; mobile fits',async({page})=>{
 const observation=observed();observation.coverage={...observation.coverage,receivedRows:200,pagination:'capped',excluded:{outside_window:198},duplicates:1};
 observation.receipts=[{...observation.receipts[0]!,rows:100},{...observation.receipts[0]!,offset:100,rows:100}];
 await page.route('**/api/v1/ranked-practice',async r=>{const p=r.request().postDataJSON();await r.fulfill({json:fixture(p.playerId,p.provider,{status:'partial',reason:null,observationIdentityRevision:'9',observationId:'11111111-1111-4111-8111-111111111111',observation})});});
 await open(page);await expect(panel(page)).toContainText('Показана часть доступной рейтинговой истории.');await expect(panel(page)).toContainText('Доступно рейтинговых карт: 1');
 await panel(page).getByText('Покрытие рейтинговой истории',{exact:true}).click();await expect(panel(page)).toContainText('Достигнут лимит');await expect(panel(page)).toContainText('Полнота всей истории');await expect(panel(page)).toContainText('Неизвестна');await expect(panel(page)).toContainText('вне выбранного периода: 198');await expect(panel(page)).not.toContainText('%');
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.locator('.ranked-practice').screenshot({path:'test-results/ranked-practice-mobile.png'});
});
test('synthetic stale cooldown retains observation, enables after deadline and never auto-refreshes provider',async({page})=>{
 await page.clock.install({time:new Date()});let calls=0;
 await page.route('**/api/v1/ranked-practice',async r=>{calls++;const p=r.request().postDataJSON();await r.fulfill({json:fixture(p.playerId,p.provider,{status:'partial',stale:true,reason:'cooldown',retryAt:new Date(Date.now()+60000).toISOString(),observationIdentityRevision:'9',observationId:'11111111-1111-4111-8111-111111111111',observation:observed()})});});
 await open(page);await expect(panel(page)).toContainText('Показаны сохранённые данные.');await expect(panel(page)).toContainText('данные устарели');
 const button=panel(page).getByRole('button',{name:'Обновить рейтинговую историю',exact:true});await expect(button).toBeDisabled();await page.clock.fastForward(61000);await expect(button).toBeEnabled();expect(calls).toBe(1);
});
test('synthetic identity/source conflicts are explained and prevent invalid refreshes',async({page})=>{
 await page.route('**/api/v1/ranked-practice',async r=>{const p=r.request().postDataJSON();await r.fulfill({json:fixture(p.playerId,p.provider,p.provider==='opendota'?{status:'conflict',identityStatus:'conflict',accountId:null,reason:'identity_conflict'}:{status:'unavailable',reason:'not_configured'})});});
 await open(page);await expect(panel(page)).toContainText('Связь игрока с аккаунтом неоднозначна.');await expect(panel(page).getByRole('button',{name:'Обновить рейтинговую историю',exact:true})).toBeDisabled();
 await panel(page).getByLabel('Источник рейтинговых игр').selectOption('stratz');await expect(panel(page)).toContainText('Этот источник не подключён.');await expect(panel(page).getByRole('button',{name:'Обновить рейтинговую историю',exact:true})).toBeDisabled();
});
test('synthetic request failure retries cache-only and a pending manual refresh blocks duplicate actions',async({page})=>{
 const refreshes:boolean[]=[];
 await page.route('**/api/v1/ranked-practice',async r=>{const p=r.request().postDataJSON();refreshes.push(p.refresh);if(refreshes.length===1){await r.fulfill({status:503,json:{error:{code:'INTERNAL_ERROR'}}});return;}
  if(p.refresh)await new Promise(resolve=>setTimeout(resolve,250));await r.fulfill({json:fixture(p.playerId,p.provider)});});
 await open(page);await expect(panel(page).getByRole('alert')).toContainText('Не удалось загрузить данные.');await panel(page).getByRole('button',{name:'Повторить проверку',exact:true}).click();await expect(panel(page)).toContainText('Рейтинговая история ещё не загружена.');
 await panel(page).getByRole('button',{name:'Загрузить рейтинговую историю',exact:true}).click();await expect(panel(page).getByRole('button',{name:'Обновляем историю…',exact:true})).toBeDisabled();await expect(panel(page).getByLabel('Источник рейтинговых игр')).toBeDisabled();
 await expect(panel(page).getByRole('button',{name:'Загрузить рейтинговую историю',exact:true})).toBeEnabled();expect(refreshes).toEqual([false,false,true]);
});
test('late cache response for the previous source cannot replace the selected source',async({page})=>{
 let release:()=>void=()=>{};const delayed=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/api/v1/ranked-practice',async r=>{const p=r.request().postDataJSON();if(p.provider==='opendota')await delayed;
  await r.fulfill({json:fixture(p.playerId,p.provider,p.provider==='stratz'?{status:'unavailable',reason:'not_configured'}:{status:'empty',reason:null})}).catch(()=>{});});
 await open(page);await panel(page).getByLabel('Источник рейтинговых игр').selectOption('stratz');await expect(panel(page)).toContainText('Этот источник не подключён.');release();
 await expect(panel(page).getByLabel('Источник рейтинговых игр')).toHaveValue('stratz');await expect(panel(page)).not.toContainText('Данные рейтинговых игр за период не получены.');
});
test('synthetic concurrent source refresh offers a cache-only check and recovers without another refresh',async({page})=>{
 const refreshes:boolean[]=[];
 await page.route('**/api/v1/ranked-practice',async r=>{const p=r.request().postDataJSON();refreshes.push(p.refresh);await r.fulfill({json:fixture(p.playerId,p.provider,refreshes.length===1?{status:'unavailable',reason:'refresh_in_progress'}:{status:'empty',reason:null})});});
 await open(page);await expect(panel(page)).toContainText('Обновление источника уже выполняется.');await expect(panel(page).getByRole('button',{name:'Обновить рейтинговую историю',exact:true})).toBeDisabled();
 await panel(page).getByRole('button',{name:'Проверить результат обновления',exact:true}).click();await expect(panel(page)).toContainText('Данные рейтинговых игр за период не получены.');expect(refreshes).toEqual([false,false]);
});
