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
   if(!source.pathname.endsWith('/rosters')){const s=syntheticSchedule();s[0]!.opponents[1]!.opponent.id+=teamShift;return Response.json(s.map(m=>({...m,status:'running',scheduled_at:new Date(Date.now()-3600000).toISOString()})));}
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
 await page.goto('/live');await page.getByLabel('Логин').fill('synthetic-auto-roster');await page.getByLabel('Пароль').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByRole('link',{name:'Live — матчи сейчас →'}).click();await page.getByRole('button',{name:'Оценить пятёрки',exact:true}).click();
}
const card=(page:Page,slot:string)=>page.getByRole('article',{name:'Выбранный состав '+slot,exact:true});

async function chooseFive(page:Page){
 await open(page);await expect(card(page,'B')).toContainText('Steam32 1007');
 for(let i=1;i<=5;i++)await card(page,'A').getByLabel(`Synthetic Player ${String(i).padStart(2,'0')} — в пятёрку A`,{exact:true}).check();
}
const confirm=(page:Page)=>page.getByRole('button',{name:'Подтвердить пятёрки и роли',exact:true});
const role=(page:Page,slot:string,index=1)=>card(page,slot).getByRole('combobox',{name:`${slot}: роль игрока ${index}`,exact:true});


const estimate=(page:Page)=>page.getByRole('region',{name:'Условная оценка по пятёркам',exact:true});
const calculate=(page:Page)=>estimate(page).getByRole('button',{name:'Рассчитать условную оценку',exact:true});
test('Live prepares five, checks acknowledgement, saves conditional result and reopens without another write',async({page})=>{
 test.setTimeout(120000);
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await chooseFive(page);await confirm(page).click();await expect(confirm(page)).toHaveAttribute('aria-pressed','true');
 await expect(calculate(page)).toBeDisabled();await estimate(page).getByLabel('Понимаю: это сравнение пятёрок без учёта текущей игры',{exact:true}).check();
 const attempts:string[]=[];
 await page.route('**/api/v1/live/70001/estimates',async route=>{if(route.request().method()!=='POST'){await route.continue();return;}attempts.push(route.request().postData()!);if(attempts.length===1){await route.fetch();await route.abort('failed');}else await route.continue();});
 await calculate(page).click();await expect(estimate(page).getByRole('alert')).toBeVisible();
 await estimate(page).getByRole('button',{name:'Повторить условную оценку',exact:true}).click();
 await expect(estimate(page).getByRole('article',{name:'Сохранённая условная оценка',exact:true})).toContainText('Нет активной проверенной модели');
 expect(attempts).toHaveLength(2);expect(attempts[0]).toBe(attempts[1]);
 expect((await sql`SELECT * FROM live_lineup_estimates`.execute(database.db)).rows).toHaveLength(1);
 for(const table of ['scenarios','prediction_runs','v1_runtime_snapshots','v1_schedule_targets'])expect((await sql`SELECT 1 FROM ${sql.table(table)}`.execute(database.db)).rows).toHaveLength(0);
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await estimate(page).screenshot({path:'.tools/live-estimate-mobile.png'});
 await page.reload();await page.getByRole('button',{name:'Оценить пятёрки',exact:true}).click();
 await expect(estimate(page).getByRole('article',{name:'Сохранённая условная оценка',exact:true})).toBeVisible();expect(attempts).toHaveLength(2);expect(errors).toEqual([]);
});
