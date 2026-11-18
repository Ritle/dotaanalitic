import {syntheticPlayerHistory} from '../../../../tests/helpers/player-history';
import {test,expect,type Page} from '@playwright/test';
import {randomBytes,createHash} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {syntheticSchedule,syntheticRosters,scheduleToken} from '../../../../tests/helpers/upcoming';
import {syntheticCatalogue} from '../../../../tests/helpers/roster-catalogue';
import {sql,IdentityRepository} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string,cookie:string,csrf:string;
let calls:string[],ambiguous:boolean,teamShift:number,historyAlias:boolean,partialTransfer:boolean;
const url='/api/v1/upcoming/70001/catalogue';
async function http(path:string,payload?:unknown){
 const response=await fetch('http://127.0.0.1:3151'+path,{method:payload===undefined?'GET':'POST',headers:{cookie,origin:'http://127.0.0.1:5179','x-csrf-token':csrf,'content-type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
 const body=await response.text();return {statusCode:response.status,body,json:()=>JSON.parse(body)};
}
const post=(path:string,payload:unknown)=>http(path,payload);
test.beforeEach(async()=>{
 database=await testDatabase();password=randomBytes(24).toString('base64url');calls=[];ambiguous=false;teamShift=0;historyAlias=false;partialTransfer=false;
 await new AuthService(database.db).provision('synthetic-auto-roster',password);
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
test.afterEach(async()=>{await api?.close();await database?.close();});
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

test('one action confirms account links and visible roles; manual corrections need one reconfirmation and reach the frozen scenario',async({page})=>{
 const requests:Record<string,unknown>[]=[],responses:Promise<unknown>[]=[];
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);let held=false;
 await page.route('**/api/v1/upcoming/70001/catalogue/apply',async route=>{if(!held){held=true;started();await gate;}await route.continue();});
 page.on('response',r=>{if(r.request().method()==='POST'&&r.url().endsWith('/catalogue/apply')){requests.push(r.request().postDataJSON());responses.push(r.json());}});
 await chooseFive(page);await role(page,'A').selectOption('2');await role(page,'B').selectOption('3');
 await expect(confirm(page)).toBeEnabled();expect(requests).toHaveLength(0);
 await confirm(page).click();await entered;await expect(page.getByRole('button',{name:'Подтверждаем…',exact:true})).toBeDisabled();
 await expect(role(page,'A')).toBeDisabled();await expect(role(page,'B')).toBeDisabled();release();await expect(confirm(page)).toHaveAttribute('aria-pressed','true');
 await expect(page.getByRole('button',{name:'Сравнить выбранные пятёрки',exact:true})).toBeEnabled();
 expect(requests).toHaveLength(2);await expect(role(page,'A')).toHaveValue('2');await expect(role(page,'B')).toHaveValue('3');
 expect((await sql`SELECT id FROM provider_player_links`.execute(database.db)).rows).toHaveLength(10);
 await role(page,'A').selectOption('4');await expect(confirm(page)).toHaveAttribute('aria-pressed','false');
 await expect(page.getByRole('button',{name:'Сравнить выбранные пятёрки',exact:true})).toBeDisabled();
 await confirm(page).click();await expect(confirm(page)).toHaveAttribute('aria-pressed','true');expect(requests).toHaveLength(2);
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('region',{name:'Составы для сравнения',exact:true}).screenshot({path:'test-results/unified-lineup-mobile.png'});
 const bindings=await Promise.all(responses) as {players:{accountId:string;playerId:string}[]}[];
 const firstAccount=(requests[0]!.players as {accountId:string}[])[0]!.accountId,player=bindings[0]!.players.find(p=>p.accountId===firstAccount)!.playerId;
 await page.getByText('Выбрать игроков для анализа одной карты',{exact:true}).click();
 const saved=page.waitForResponse(r=>r.url().endsWith('/api/v1/scenarios')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Создать ручной сценарий',exact:true}).click();const response=await saved;expect(response.status()).toBe(201);
 const body=response.request().postDataJSON();expect(body.confirmedByOwner).toBe(true);expect(body.lineupA.find((p:{playerId:string})=>p.playerId===player).rolePos).toBe(4);
 const snapshot=await response.json();expect(snapshot.input.lineupA.find((p:{playerId:string})=>p.playerId===player).rolePos).toBe(4);
});

test('a second-team conflict leaves partial links explicit, never confirms both, and retries only the unresolved side with reviewed roles',async({page})=>{
 let attempts=0;await page.route('**/api/v1/upcoming/70001/catalogue/apply',r=>++attempts===2?r.fulfill({status:409,json:{error:{code:'SYNTHETIC_LINK_CONFLICT',message:'Связи изменились. Перечитайте связи.',requestId:'synthetic-unified'}}}):r.continue());
 await chooseFive(page);await role(page,'A').selectOption('2');await role(page,'B').selectOption('3');
 await confirm(page).click();await expect(page.getByText('Общее подтверждение не выполнено.',{exact:false})).toBeVisible();
 await expect(confirm(page)).toHaveAttribute('aria-pressed','false');await expect(page.getByRole('button',{name:'Сравнить выбранные пятёрки',exact:true})).toBeDisabled();
 expect((await sql`SELECT id FROM provider_player_links`.execute(database.db)).rows).toHaveLength(5);await expect(role(page,'A')).toHaveValue('2');await expect(role(page,'B')).toHaveValue('3');
 await page.getByRole('button',{name:'Подготовить составы',exact:true}).click();await page.getByRole('button',{name:'Перечитать связи',exact:true}).click();
 await expect(confirm(page)).toBeEnabled();await confirm(page).click();await expect(confirm(page)).toHaveAttribute('aria-pressed','true');
 expect(attempts).toBe(3);await expect(role(page,'A')).toHaveValue('2');await expect(role(page,'B')).toHaveValue('3');
 expect((await sql`SELECT id FROM provider_player_links`.execute(database.db)).rows).toHaveLength(10);
});

for(const manual of [false,true])test(`local role hints ${manual?'preserve a manual edit made before the response':'fill the visible prepared five before account confirmation'}`,async({page})=>{
 const identity=new IdentityRepository(database.db),at=new Date().toISOString();
 for(let i=0;i<6;i++){
  const id=String(990100+i),account=String(1001+i);
  await sql`INSERT INTO players(id,nickname) VALUES(${id},${'Synthetic Player '+String(i+1).padStart(2,'0')})`.execute(database.db);
  await identity.appendAccountEvidence({playerId:id,externalAccountId:account,provider:'opendota',status:'verified',eventAt:null,knownAt:at,fetchedAt:at,evidenceRef:'synthetic role draft',source:'synthetic'});
 }
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);
 await page.route('**/api/v1/lineup-role-suggestions',async route=>{
  const response=await route.fetch(),report=await response.json();
  report.players=report.players.map((p:{playerId:string},i:number)=>({...p,suggestedRole:5-i}));
  started();if(manual)await gate;await route.fulfill({json:report});
 });
 await chooseFive(page);await entered;
 if(manual){await role(page,'A').selectOption('4');release();}
 const suggestions=page.getByRole('region',{name:'Автоопределение ролей A',exact:true}),apply=suggestions.getByRole('button',{name:'Применить роли A',exact:true});
 if(manual){
  await expect(apply).toBeEnabled();await expect(role(page,'A')).toHaveValue('4');await apply.click();
  await expect(role(page,'A')).toHaveValue('5');
 }else await expect(role(page,'A')).toHaveValue('5');
 await expect(apply).toBeDisabled();await expect(suggestions.getByRole('status')).toContainText('Роли A уже расставлены в форме');
 await expect(suggestions.getByRole('status')).toContainText('Подтвердить пятёрки и роли');
 expect((await sql`SELECT id FROM provider_player_links`.execute(database.db)).rows).toHaveLength(0);
 expect(calls).toEqual(['registry']);
});

test('clarifying a prepared account keeps the reviewed roles and still requires numeric confirmation',async({page})=>{
 await chooseFive(page);await role(page,'A').selectOption('4');
 await page.getByRole('button',{name:'Подготовить составы',exact:true}).click();
 const picker=page.getByRole('region',{name:'Аккаунт Synthetic Player 01 (A)',exact:true});
 await picker.getByRole('searchbox').fill('1006');await picker.getByRole('searchbox').press('Enter');
 await picker.getByRole('button',{name:/ · ID 1006$/}).click();
 await expect(card(page,'A')).toContainText('Steam32 1006');await expect(role(page,'A')).toHaveValue('4');
 await expect(role(page,'A',4)).toHaveValue('1');await expect(confirm(page)).toHaveAttribute('aria-pressed','false');
 expect((await sql`SELECT id FROM provider_player_links`.execute(database.db)).rows).toHaveLength(0);
 await confirm(page).click();await expect(confirm(page)).toHaveAttribute('aria-pressed','true');await expect(role(page,'A')).toHaveValue('4');
});


test('review displays Carry through Hard Support before and after binding while the same player keeps edits',async({page})=>{
 await chooseFive(page);
 const values=async()=>card(page,'A').getByRole('combobox').evaluateAll(nodes=>nodes.map(n=>(n as HTMLSelectElement).value));
 expect(await values()).toEqual(['1','2','3','4','5']);
 await expect(role(page,'A').getByRole('option')).toHaveText(['1. Carry','2. Mid','3. Offlane','4. SemiSupport','5. Hard Support']);
 await role(page,'A').selectOption('5');expect(await values()).toEqual(['1','2','3','4','5']);await expect(role(page,'A')).toHaveValue('5');
 await expect(card(page,'A').locator('[data-review-role="5"]')).toContainText('Synthetic Player 01');
 await confirm(page).click();await expect(confirm(page)).toHaveAttribute('aria-pressed','true');expect(await values()).toEqual(['1','2','3','4','5']);await expect(role(page,'A')).toHaveValue('5');
 await role(page,'A').selectOption('2');expect(await values()).toEqual(['1','2','3','4','5']);await expect(card(page,'A').locator('[data-review-role="2"]')).toContainText('Synthetic Player 01');
 await expect(confirm(page)).toHaveAttribute('aria-pressed','false');
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await card(page,'A').screenshot({path:'.tools/role-review-order-20261112/mobile.png'});
});
