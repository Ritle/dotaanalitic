import {test,expect,type Page} from '@playwright/test';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {syntheticSchedule,syntheticRosters,scheduleToken} from '../../../../tests/helpers/upcoming';
import {syntheticCatalogue} from '../../../../tests/helpers/roster-catalogue';
import {sql} from '../../../../packages/db/src/index';
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
  db:database.db,logger:false,catalogueProvider:async key=>{
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
test.afterEach(async({page})=>{await page.close();await api?.close();await database?.close();});
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

async function prepareSaved(page:Page){await chooseFive(page);await role(page,'A').selectOption('4');await role(page,'B').selectOption('3');await confirm(page).click();await expect(confirm(page)).toHaveAttribute('aria-pressed','true');}
const template=(page:Page,slot:string)=>page.getByRole('region',{name:'Шаблон владельца '+slot,exact:true});
async function reopen(page:Page){await page.reload();await page.getByRole('button',{name:'Выбрать',exact:true}).click();}

test('owner confirms once, reuses roles after reload and records only changed assignments with author/revision',async({page})=>{
 const writes:string[]=[];page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/lineup-template'))writes.push(r.url());});
 await prepareSaved(page);expect(writes).toHaveLength(2);await expect(template(page,'A')).toContainText('Подтвердил synthetic-auto-roster');
 await expect(template(page,'A')).toContainText('редакция 1');await expect(confirm(page)).toBeDisabled();await expect(confirm(page)).toHaveAttribute('aria-pressed','true');expect(writes).toHaveLength(2);
 await reopen(page);await expect(role(page,'A')).toHaveValue('4');await expect(role(page,'B')).toHaveValue('3');await expect(confirm(page)).toHaveAttribute('aria-pressed','true');
 await expect(page.getByRole('button',{name:'Получить прогноз первой карты',exact:true})).toBeEnabled();expect(writes).toHaveLength(2);
 await role(page,'A').selectOption('2');await confirm(page).click();await expect(confirm(page)).toHaveAttribute('aria-pressed','true');expect(writes).toHaveLength(3);await expect(template(page,'A')).toContainText('редакция 2');
 expect((await sql`SELECT id FROM owner_lineup_templates`.execute(database.db)).rows).toHaveLength(3);
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('region',{name:'Составы для сравнения',exact:true}).screenshot({path:'test-results/owner-lineup-templates-mobile.png'});
});

test('a replacement makes the old template inapplicable and needs an explicit owner confirmation',async({page})=>{
 await prepareSaved(page);await sql`INSERT INTO players(id,nickname) VALUES(990999,'Synthetic Replacement')`.execute(database.db);
 await page.getByRole('button',{name:'Изменить игроков и роли',exact:true}).click();
 const picker=page.getByRole('region',{name:'A: игрок 1',exact:true});await picker.getByRole('button',{name:'Заменить',exact:true}).click();await picker.getByRole('searchbox').fill('990999');await picker.getByRole('searchbox').press('Enter');await picker.locator('button[data-catalog-id="990999"]').click();
 await expect(template(page,'A')).toContainText('Шаблон сохранён для другой пятёрки');await expect(confirm(page)).toHaveAttribute('aria-pressed','false');
 await confirm(page).click();await expect(confirm(page)).toHaveAttribute('aria-pressed','true');await expect(template(page,'A')).toContainText('редакция 2');
 // The unchanged source still has the old five: it cannot inherit the replacement's template.
 await reopen(page);await expect(template(page,'A')).toContainText('Шаблон сохранён для другой пятёрки');await expect(role(page,'A')).toHaveValue('1');
});

test('manual roles survive a late template response',async({page})=>{
 await prepareSaved(page);let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);let held=false;
 await page.route('**/api/v1/teams/*/lineup-template',async route=>{
  if(route.request().method()==='GET'&&!held){held=true;const response=await route.fetch();started();await gate;await route.fulfill({response});}else await route.continue();
 });
 await reopen(page);await entered;await role(page,'A').selectOption('5');release();await expect(template(page,'A')).toContainText('редакция 1');await expect(role(page,'A')).toHaveValue('5');await expect(confirm(page)).toHaveAttribute('aria-pressed','false');
});

test('template409 retains manual roles and reread allows a new explicit confirmation',async({page})=>{
 await prepareSaved(page);let failed=false;
 await page.route('**/api/v1/teams/*/lineup-template',route=>{if(route.request().method()==='POST'&&!failed){failed=true;return route.fulfill({status:409,json:{error:{code:'LINEUP_TEMPLATE_CONFLICT',message:'synthetic revision conflict',requestId:'synthetic-template'}}});}return route.continue();});
 await role(page,'A').selectOption('2');await confirm(page).click();await expect(page.getByText('Общее подтверждение не выполнено.',{exact:false})).toBeVisible();await expect(confirm(page)).toHaveAttribute('aria-pressed','false');await expect(role(page,'A')).toHaveValue('2');
 await expect(confirm(page)).toBeDisabled();await template(page,'A').getByRole('button',{name:'Перечитать шаблон A',exact:true}).click();await expect(confirm(page)).toBeEnabled();await confirm(page).click();await expect(confirm(page)).toHaveAttribute('aria-pressed','true');await expect(role(page,'A')).toHaveValue('2');
});

test('reserved user role sees owner assignments without editing controls or automatic writes',async({page})=>{
 await prepareSaved(page);await sql`UPDATE app_users SET account_role='user'`.execute(database.db);
 const writes:string[]=[];page.on('request',r=>{if(r.method()==='POST')writes.push(new URL(r.url()).pathname);});
 await reopen(page);await expect(role(page,'A')).toHaveValue('4');for(const slot of ['A','B'])for(let i=1;i<=5;i++)await expect(role(page,slot,i)).toBeDisabled();
 await expect(confirm(page)).toHaveCount(0);await expect(page.getByRole('button',{name:'Изменить игроков и роли',exact:true})).toHaveCount(0);await expect(template(page,'A')).toContainText('Просмотр назначений владельца');expect(writes).toEqual([]);
 const team=(await sql<{team_id:string}>`SELECT team_id::text FROM owner_lineup_templates ORDER BY id LIMIT 1`.execute(database.db)).rows[0]!.team_id;
 const denied=await post('/api/v1/teams/'+team+'/lineup-template',{requestId:randomUUID(),expectedRevision:1,confirmedByOwner:true,lineup:[]});expect(denied.statusCode).toBe(403);expect((await sql`SELECT id FROM owner_lineup_templates`.execute(database.db)).rows).toHaveLength(2);
});

test('leaving during template lookup cannot start a template write for a disposed page',async({page})=>{
 let release!:()=>void,started!:()=>void,finished!:()=>void;
 const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r),done=new Promise<void>(r=>finished=r);let held=false,writes=0;
 await page.route('**/api/v1/teams/*/lineup-template',async route=>{
  if(route.request().method()==='GET'&&!held){held=true;const response=await route.fetch();started();await gate;await route.fulfill({response}).catch(()=>undefined);finished();}else{if(route.request().method()==='POST')writes++;await route.continue();}
 });
 await chooseFive(page);await confirm(page).click();await entered;await page.goto('/');release();await done;
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 expect(writes).toBe(0);expect((await sql`SELECT id FROM owner_lineup_templates`.execute(database.db)).rows).toHaveLength(0);
});
