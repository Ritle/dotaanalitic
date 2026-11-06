import {test,expect,type Page} from '@playwright/test';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
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
test.afterEach(async()=>{await api?.close();await database?.close();});
async function open(page:Page){
 await page.goto('/upcoming');await page.getByLabel('Логин').fill('synthetic-auto-roster');await page.getByLabel('Пароль').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByRole('link',{name:'Предстоящие матчи →'}).click();await page.getByRole('button',{name:'Выбрать',exact:true}).click();
}
const card=(page:Page,slot:string)=>page.getByRole('article',{name:'Выбранный состав '+slot,exact:true});
test('automatic preparation displays candidates, selects five of six without technical forms, and reuses saved fives',async({page})=>{
 const preparations:unknown[]=[],writes:string[]=[];page.on('request',r=>{if(r.url().endsWith('/catalogue/prepare'))preparations.push(r.postDataJSON());if(r.method()==='POST')writes.push(new URL(r.url()).pathname);});
 await open(page);await expect(card(page,'B').getByRole('button',{name:'Подтвердить аккаунты и выбрать пятёрку B',exact:true})).toBeEnabled();
 await expect(card(page,'A')).toContainText('В заявке 6 игроков');await expect(card(page,'B')).toContainText('Steam32 1007');
 expect(preparations).toEqual([{externalSearch:false}]);expect(calls).toEqual(['registry']);
 expect((await sql`SELECT id FROM provider_player_links`.execute(database.db)).rows).toHaveLength(0);
 await card(page,'B').getByRole('button',{name:'Подтвердить аккаунты и выбрать пятёрку B',exact:true}).click();await expect(card(page,'B')).toContainText('Выбрано 5 / 5');
 for(let i=1;i<=5;i++)await card(page,'A').getByLabel(`Synthetic Player ${String(i).padStart(2,'0')} — в пятёрку A`,{exact:true}).check();
 await card(page,'A').getByRole('button',{name:'Подтвердить аккаунты и выбрать пятёрку A',exact:true}).click();await expect(card(page,'A')).toContainText('Выбрано 5 / 5');
 await expect(page.getByRole('region',{name:'Команда A в локальной базе',exact:true})).not.toBeVisible();
 await page.getByLabel('Подтверждаю выбранных игроков и роли для одной карты',{exact:true}).check();await expect(page.getByRole('button',{name:'Сравнить выбранные пятёрки',exact:true})).toBeEnabled();
 expect(preparations).toHaveLength(1);expect(writes.filter(p=>p.endsWith('/catalogue/apply'))).toHaveLength(2);
 expect((await sql`SELECT id FROM provider_player_links`.execute(database.db)).rows).toHaveLength(10);
 await page.reload();await page.getByRole('button',{name:'Выбрать',exact:true}).click();await expect(card(page,'B')).toContainText('Выбрано 5 / 5');expect(preparations).toHaveLength(1);
 await page.getByRole('button',{name:'Изменить игроков и роли',exact:true}).click();
 for(const slot of ['A','B']){
  const auto=page.getByLabel(`Автоподстановка ролей ${slot}`,{exact:true});
  await expect(auto).not.toBeChecked();await auto.check();await expect(auto).toBeChecked();
 }
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('verified global player links automatically fill a new organization without nickname decisions',async({page})=>{
 const ready=(await post(url+'/prepare',{externalSearch:false})).json(),state=(await http(url)).json(),team=ready.teams[1];
 const saved=await post(url+'/apply',{requestId:randomUUID(),providerTeamId:'74002',teamId:'74002',teamProvider:'pandascore',expectedRevision:0,
  rosterSha256:state.rosterSha256,registrySha256:ready.registrySha256,confirmedByOwner:true,
  players:team.players.map((p:{providerPlayerId:string;linkToken:string;candidates:{id:string}[]})=>({providerPlayerId:p.providerPlayerId,accountId:p.candidates[0]!.id,linkToken:p.linkToken}))});
 expect(saved.statusCode,saved.body).toBe(200);
 // The same provider players transfer to a new source organization; old decisions stay immutable.
 teamShift=10;await sql`UPDATE upcoming_source_cache SET expires_at=clock_timestamp()-interval '1 second',retry_at='-infinity'`.execute(database.db);
 await sql`UPDATE pandascore_request_quota SET next_request_at='-infinity'`.execute(database.db);
 await post('/api/v1/upcoming/refresh',{});await post('/api/v1/upcoming/tournaments/71001/refresh',{});
 let applies=0;page.on('request',r=>{if(r.url().endsWith('/catalogue/apply'))applies++;});
 await open(page);await expect(card(page,'B')).toContainText('Выбрано 5 / 5');expect(applies).toBe(1);
 await expect(card(page,'A')).toContainText('В заявке 6 игроков');
 expect((await sql`SELECT id FROM expected_roster_catalogue_bindings`.execute(database.db)).rows).toHaveLength(2);
});
test('partial verified links are labelled separately from suggestions and a manual account replacement loses the verified label',async({page})=>{
 const ready=(await post(url+'/prepare',{externalSearch:false})).json(),state=(await http(url)).json(),team=ready.teams[1];
 const saved=await post(url+'/apply',{requestId:randomUUID(),providerTeamId:'74002',teamId:'74002',teamProvider:'pandascore',expectedRevision:0,
  rosterSha256:state.rosterSha256,registrySha256:ready.registrySha256,confirmedByOwner:true,
  players:team.players.map((p:{providerPlayerId:string;linkToken:string;candidates:{id:string}[]})=>({providerPlayerId:p.providerPlayerId,accountId:p.candidates[0]!.id,linkToken:p.linkToken}))});
 expect(saved.statusCode,saved.body).toBe(200);
 // A new organization reuses four numeric links; its fifth provider identity is still unconfirmed.
 teamShift=10;partialTransfer=true;await sql`UPDATE upcoming_source_cache SET expires_at=clock_timestamp()-interval '1 second',retry_at='-infinity'`.execute(database.db);
 await sql`UPDATE pandascore_request_quota SET next_request_at='-infinity'`.execute(database.db);
 await post('/api/v1/upcoming/refresh',{});await post('/api/v1/upcoming/tournaments/71001/refresh',{});
 let applies=0;page.on('request',r=>{if(r.url().endsWith('/catalogue/apply'))applies++;});
 await open(page);const b=card(page,'B');
 await expect(b.getByText('Связь аккаунта подтверждена ранее',{exact:true})).toHaveCount(4);
 await expect(b.getByText('Предложенный аккаунт — проверьте и подтвердите',{exact:true})).toHaveCount(1);
 await expect(b.getByText('Аккаунт требует уточнения',{exact:true})).toHaveCount(0);
 await expect(b.getByRole('button',{name:'Подтвердить аккаунты и выбрать пятёрку B',exact:true})).toBeEnabled();
 await expect(page.getByRole('button',{name:'Сравнить выбранные пятёрки',exact:true})).toBeDisabled();expect(applies).toBe(0);
 await page.getByRole('button',{name:'Подготовить составы',exact:true}).click();const editor=page.getByRole('region',{name:'Соединение B',exact:true});
 await editor.getByLabel('Показать подтверждённые аккаунты B',{exact:true}).check();
 const picker=editor.getByRole('region',{name:'Аккаунт Synthetic Player 07 (B)',exact:true});
 await picker.getByRole('searchbox').fill('1001');await picker.getByRole('searchbox').press('Enter');await picker.getByRole('button',{name:/ · ID 1001$/}).click();
 await expect(b.getByText('Связь аккаунта подтверждена ранее',{exact:true})).toHaveCount(3);
 await expect(b.getByText('Выбран другой аккаунт — требуется подтверждение',{exact:true})).toHaveCount(1);
 expect(applies).toBe(0);expect((await sql`SELECT id FROM expected_roster_catalogue_bindings`.execute(database.db)).rows).toHaveLength(1);
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await b.screenshot({path:'test-results/partial-linked-roster-mobile.png'});
});

test('ambiguous nicknames remain visible and make no automatic identity decision or roster write',async({page})=>{
 ambiguous=true;
 // Refresh only the isolated synthetic source snapshot so the ambiguity is part of the source data.
 await sql`UPDATE upcoming_source_cache SET expires_at=clock_timestamp()-interval '1 second',retry_at='-infinity'`.execute(database.db);
 await sql`UPDATE pandascore_request_quota SET next_request_at='-infinity'`.execute(database.db);
 await post('/api/v1/upcoming/tournaments/71001/refresh',{});
 await open(page);await expect(card(page,'B')).toContainText('Несколько аккаунтов');
 await expect(card(page,'B').getByRole('button',{name:'Подтвердить аккаунты и выбрать пятёрку B',exact:true})).toHaveCount(0);
 expect(calls).toEqual(['registry']);expect((await sql`SELECT id FROM provider_player_links`.execute(database.db)).rows).toHaveLength(0);
});

test('a unique local pro-history candidate preloads as an unconfirmed draft and all alternatives remain selectable',async({page})=>{
 const identity=new IdentityRepository(database.db),at=new Date().toISOString();
 for(const [id,account] of [['99001','200001'],['99002','200002']]){
  await sql`INSERT INTO players(id,nickname) VALUES(${id},'Synthetic disputed history')`.execute(database.db);
  await identity.appendAccountEvidence({playerId:id!,externalAccountId:account!,provider:'opendota',status:'verified',eventAt:null,knownAt:at,fetchedAt:at,evidenceRef:'synthetic history candidate',source:'synthetic'});
 }
 await sql`INSERT INTO heroes(id,localized_name,internal_name) VALUES(99001,'Synthetic history hero','synthetic_history_hero')`.execute(database.db);
 await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,source,ingest_state) VALUES(99001,clock_timestamp()-interval '1 day',60,true,true,'synthetic','accepted')`.execute(database.db);
 await sql`INSERT INTO match_players(match_id,player_slot,side,player_id,hero_id,source_account_id) VALUES(99001,0,'radiant',99002,99001,200002)`.execute(database.db);
 historyAlias=true;await sql`UPDATE upcoming_source_cache SET expires_at=clock_timestamp()-interval '1 second',retry_at='-infinity'`.execute(database.db);
 await sql`UPDATE pandascore_request_quota SET next_request_at='-infinity'`.execute(database.db);await post('/api/v1/upcoming/tournaments/71001/refresh',{});
 await open(page);await expect(card(page,'A')).toContainText('Steam32 200002');
 await expect(card(page,'A')).toContainText('Предложен по наличию pro-истории');
 expect((await sql`SELECT id FROM provider_player_links`.execute(database.db)).rows).toHaveLength(0);
 await card(page,'A').getByRole('button',{name:'Уточнить аккаунты A',exact:true}).click();
 const panel=page.getByRole('region',{name:'Соединение A',exact:true});await panel.getByLabel('Synthetic disputed history — включить в пятёрку',{exact:true}).check();
 const picker=panel.getByRole('region',{name:'Аккаунт Synthetic disputed history (A)',exact:true});
 await expect(picker.getByRole('button',{name:/ · ID 200002$/})).toHaveAttribute('aria-pressed','true');
 await expect(picker.getByText('Локальные pro-карты: 1',{exact:true})).toBeVisible();
 await picker.getByRole('button',{name:/ · ID 200001$/}).click();
 await expect(picker.getByRole('button',{name:/ · ID 200001$/})).toHaveAttribute('aria-pressed','true');
 expect((await sql`SELECT id FROM provider_player_links`.execute(database.db)).rows).toHaveLength(0);
});
