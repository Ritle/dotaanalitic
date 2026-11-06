import {test,expect,type Page,type BrowserContext} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedProMaps} from '../../../../tests/helpers/pro-maps';
import {catalogPlayerId} from '../../../../tests/helpers/catalog';
import {seedRankedContext,rankedContextResponse} from '../../../../tests/helpers/ranked-context';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
import {RankedPracticeService} from '../../../api/src/modules/catalog/ranked-practice';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,state:Awaited<ReturnType<BrowserContext['storageState']>>,seed:Awaited<ReturnType<typeof seedRankedContext>>,service:RankedPracticeService,providerCalls=0;
test.beforeAll(async({browser})=>{
 database=await testDatabase();await seedProMaps(database.db);seed=await seedRankedContext(database.db);const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-context-browser',password);
 const config=readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',RANKED_PRACTICE_ENABLED:'true',STRATZ_API_TOKEN:'synthetic-context-browser-key'}),fetcher:typeof fetch=async(_,init)=>{providerCalls++;const body=JSON.parse(String(init?.body));return new Response(JSON.stringify({data:rankedContextResponse(body.query,seed.rows,String(body.variables.account))}));};
 service=new RankedPracticeService(database.db,config,fetcher);api=await buildApp(config,{db:database.db,logger:false,rankedPracticeFetch:fetcher});await api.listen({host:'127.0.0.1',port:3151});
 const context=await browser.newContext(),page=await context.newPage();await page.goto('/login');await page.getByLabel('Логин').fill('synthetic-context-browser');await page.getByLabel('Пароль').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Справочники',exact:true})).toBeVisible();state=await context.storageState();await context.close();
});
test.beforeEach(async({context})=>{await context.addCookies(state.cookies);});test.afterAll(async()=>{await api?.close();await database?.close();});
const ranked=(page:Page)=>page.getByRole('region',{name:'Рейтинговая практика игрока',exact:true}),panel=(page:Page)=>page.getByRole('region',{name:'Дополнение рейтинговых карт STRATZ',exact:true});
async function openParent(page:Page){await page.goto('/players/'+catalogPlayerId);await page.locator('.ranked-practice>summary').click();await expect(ranked(page)).toContainText('Доступно рейтинговых карт: 21');}
async function open(page:Page){await openParent(page);await page.locator('.ranked-context>summary').click();await expect(panel(page)).toBeVisible();}
const snapshot=()=>service.context.report({playerId:seed.playerId,parentObservationId:seed.parentId,refresh:false});
test('collapsed context performs no query; explicit action uses5 source requests and repeated action/reload only cache',async({page})=>{
 const refreshes:boolean[]=[];page.on('request',r=>{if(r.url().endsWith('/ranked-practice/context'))refreshes.push(r.postDataJSON().refresh);});await openParent(page);expect(refreshes).toEqual([]);const before=providerCalls;
 await page.locator('.ranked-context>summary').focus();await page.keyboard.press('Enter');await expect(panel(page)).toContainText('Дополнительные данные ещё не загружены.');expect(refreshes).toEqual([false]);expect(providerCalls).toBe(before);
 await panel(page).getByRole('button',{name:'Дополнить данные STRATZ',exact:true}).click();await expect(panel(page).getByRole('button',{name:'Дополняем данные…',exact:true})).toBeDisabled();await expect(ranked(page).getByLabel('Источник рейтинговых игр')).toBeDisabled();
 await expect(panel(page)).toContainText('Дополнено 20 из 20 выбранных карт. Основная выборка OpenDota: 21.',{timeout:20000});expect(providerCalls).toBe(before+5);await expect(panel(page)).toContainText('оценка позиции известна для 20');await expect(panel(page).getByRole('table').getByRole('row')).toHaveCount(21);
 await panel(page).getByRole('button',{name:'Дополнить данные STRATZ',exact:true}).click();await expect(panel(page).getByRole('button',{name:'Дополнить данные STRATZ',exact:true})).toBeEnabled();expect(providerCalls).toBe(before+5);
 await open(page);await expect(panel(page)).toContainText('Дополнено 20 из 20');expect(providerCalls).toBe(before+5);expect(refreshes).toEqual([false,true,true,false]);await expect(ranked(page)).toContainText('21 наблюдаемых игр');
});
test('cached context is labelled estimated/provider code and scrolls inside360px without provider calls',async({page})=>{
 const before=providerCalls;await open(page);await expect(panel(page)).toContainText('Дополнено 20 из 20');await expect(panel(page).getByRole('cell',{name:'2 (оценка)',exact:true}).first()).toBeVisible();await expect(panel(page)).toContainText('версия — его собственный код');
 await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const scroll=panel(page).getByRole('region',{name:'Таблица дополнения STRATZ'});await scroll.focus();await page.keyboard.press('ArrowRight');await expect.poll(()=>scroll.evaluate(el=>el.scrollLeft)).toBeGreaterThan(0);expect(providerCalls).toBe(before);await page.locator('.ranked-context').screenshot({path:'test-results/ranked-context-mobile.png'});
});
test('synthetic conflicting/unknown/stale rows expose coverage and cooldown never triggers source polling',async({page})=>{
 await page.clock.install({time:new Date()});const source=await snapshot(),first=source.maps[0]!,second=source.maps[1]!;let calls=0;
 const value={...source,status:'partial',reason:'cooldown',retryAt:new Date(Date.now()+60000).toISOString(),matchedMaps:19,maps:[{...first,status:'conflict',reason:'hero_mismatch',position:null,roleBasis:'unknown',gameVersionCode:null,averageRank:null,stale:true},{...second,position:null,roleBasis:'unknown',gameVersionCode:null},...source.maps.slice(2)]};
 await page.route('**/api/v1/ranked-practice/context',async r=>{calls++;await r.fulfill({json:value});});await open(page);await expect(panel(page)).toContainText('Расхождения: 1');await expect(panel(page)).toContainText('Часть данных устарела');await expect(panel(page).getByRole('cell',{name:'Герой не совпал.',exact:true})).toBeVisible();
 const button=panel(page).getByRole('button',{name:'Дополнить данные STRATZ',exact:true});await expect(button).toBeDisabled();await page.clock.fastForward(61000);await expect(button).toBeEnabled();expect(calls).toBe(1);
});
test('synthetic active lease allows cache-only recovery without launching another source capture',async({page})=>{
 const source=await snapshot(),refreshes:boolean[]=[];await page.route('**/api/v1/ranked-practice/context',async r=>{refreshes.push(r.request().postDataJSON().refresh);await r.fulfill({json:refreshes.length===1?{...source,status:'partial',reason:'refresh_in_progress'}:source});});
 await open(page);await expect(panel(page)).toContainText('Дополнение уже выполняется.');await expect(panel(page).getByRole('button',{name:'Дополнить данные STRATZ',exact:true})).toBeDisabled();await panel(page).getByRole('button',{name:'Проверить сохранённое дополнение',exact:true}).click();await expect(panel(page).getByRole('button',{name:'Дополнить данные STRATZ',exact:true})).toBeEnabled();expect(refreshes).toEqual([false,false]);
});
test('late context response cannot appear after parent source is changed and child unmounted',async({page})=>{
 const source=await snapshot();let release:()=>void=()=>{};const delayed=new Promise<void>(resolve=>{release=resolve;});await page.route('**/api/v1/ranked-practice/context',async r=>{await delayed;await r.fulfill({json:source}).catch(()=>{});});
 await open(page);await ranked(page).getByLabel('Источник рейтинговых игр').selectOption('stratz');release();await expect(ranked(page)).toContainText('Рейтинговая история ещё не загружена.');await expect(panel(page)).toHaveCount(0);await expect(ranked(page)).not.toContainText('Дополнено 20');
});
test('synthetic transport retry is cache-only and manual request blocks duplicate/source edits',async({page})=>{
 const source=await snapshot(),refreshes:boolean[]=[];await page.route('**/api/v1/ranked-practice/context',async r=>{const p=r.request().postDataJSON();refreshes.push(p.refresh);if(refreshes.length===1){await r.fulfill({status:503,json:{error:{code:'INTERNAL_ERROR'}}});return;}if(p.refresh)await new Promise(resolve=>setTimeout(resolve,300));await r.fulfill({json:source});});
 await open(page);await expect(panel(page).getByRole('alert')).toBeVisible();await panel(page).getByRole('button',{name:'Повторить проверку дополнения',exact:true}).click();await expect(panel(page)).toContainText('Дополнено 20');await panel(page).getByRole('button',{name:'Дополнить данные STRATZ',exact:true}).click();await expect(panel(page).getByRole('button',{name:'Дополняем данные…',exact:true})).toBeDisabled();await expect(ranked(page).getByLabel('Источник рейтинговых игр')).toBeDisabled();await expect(panel(page).getByRole('button',{name:'Дополнить данные STRATZ',exact:true})).toBeEnabled();expect(refreshes).toEqual([false,false,true]);
});
test('synthetic changed parent clears metadata and disables an invalid refresh',async({page})=>{
 const source=await snapshot();await page.route('**/api/v1/ranked-practice/context',async r=>r.fulfill({json:{...source,status:'unavailable',reason:'parent_changed',parentFromAt:null,parentCutoffAt:null,parentGames:0,selectedMaps:0,matchedMaps:0,maps:[]}}));
 await open(page);await expect(panel(page)).toContainText('Рейтинговая история изменилась.');await expect(panel(page).getByRole('button',{name:'Дополнить данные STRATZ',exact:true})).toBeDisabled();await expect(panel(page).getByRole('table')).toHaveCount(0);
});
