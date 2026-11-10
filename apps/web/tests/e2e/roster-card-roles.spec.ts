import {test,expect,type Page} from '@playwright/test';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {testDatabase} from '../../../../tests/helpers/postgres';
import {seedProMaps} from '../../../../tests/helpers/pro-maps';
import {catalogPlayerId,catalogTeamId} from '../../../../tests/helpers/catalog';
import {RoleProfileRepository,sql} from '../../../../packages/db/src/index';
import {buildApp} from '../../../api/src/app';
import {readConfig} from '../../../api/src/config';
import {AuthService} from '../../../api/src/modules/auth/service';
let database:Awaited<ReturnType<typeof testDatabase>>,api:FastifyInstance,password:string,memberCount:number,profileCalls:number;
test.beforeEach(async()=>{
 database=await testDatabase();await seedProMaps(database.db);memberCount=6;profileCalls=0;
 await sql`UPDATE teams SET opendota_team_id=71 WHERE id=${catalogTeamId}`.execute(database.db);
 await sql`UPDATE matches SET started_at=clock_timestamp()-CASE WHEN id=8001 THEN interval '2 days' ELSE interval '1 day' END WHERE id IN(8001,8002)`.execute(database.db);
 password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-card-roles',password);
 const owner=(await sql<{id:string}>`SELECT id FROM app_users`.execute(database.db)).rows[0]!.id,repository=new RoleProfileRepository(database.db);
 await repository.saveBinding(owner,catalogTeamId,{requestId:randomUUID(),expectedRevision:0,confirmedByOwner:true,binding:{stratzTeamId:'77',pandaTournamentId:null,pandaTeamId:null,pandaPlayers:[]}});
 for(const [account,role] of [['1000',3],['1001',5]] as const){
  const key='stratz:player:'+account,lease=await repository.claim(key);expect(lease).not.toBeNull();
  await repository.publish(key,lease!,{provider:'stratz',sourceKey:key,fetchedAt:new Date().toISOString(),knownAt:null,eventAt:null,payloadSha256:'a'.repeat(64),players:[{accountId:account,providerPlayerId:account,providerTeamId:'77',name:'Synthetic cached profile',roles:[role]}]});
 }
 await sql`UPDATE role_profile_cache SET expires_at=clock_timestamp()-interval '1 second' WHERE source_key='stratz:player:1001'`.execute(database.db);
 api=await buildApp(readConfig({DATABASE_URL:database.url,WEB_ORIGIN:'http://127.0.0.1:5179',ROLE_PROFILES_ENABLED:'true',STRATZ_API_TOKEN:'synthetic-card-role-token'}),{db:database.db,logger:false,
  roleProfileFetch:async()=>{profileCalls++;throw Error('unexpected_profile_http');},catalogueProvider:async()=>{
   const rawBody=JSON.stringify(Array.from({length:memberCount},(_,i)=>({account_id:1000+i,steamid:String(76561197960265728n+1000n+BigInt(i)),name:'Synthetic member '+i,team_id:71,team_name:'Synthetic Aurora'})));
   return {rawBody,source:{endpoint:'/proPlayers',fetchedAt:new Date().toISOString(),payloadSha256:createHash('sha256').update(rawBody).digest('hex')}};
  }});await api.listen({host:'127.0.0.1',port:3151});
});
test.afterEach(async()=>{await api?.close();await database?.close();});
const card=(page:Page)=>page.getByRole('region',{name:'Состав по OpenDota',exact:true});
async function open(page:Page){await page.goto('/login');await page.getByLabel('Логин',{exact:true}).fill('synthetic-card-roles');await page.getByLabel('Пароль',{exact:true}).fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('heading',{name:'Справочники',exact:true}).waitFor();await page.goto('/teams/'+catalogTeamId);await card(page).getByRole('button',{name:'Обновить из OpenDota',exact:true}).click();}
test('current role labels use cached profiles and pro evidence with conflicts, bench members, no external refresh and no historical relabeling',async({page})=>{
 const requests:{playerIds:string[];refreshProfiles:boolean;cutoffAt:string}[]=[],errors:string[]=[],serverTimes:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('response',async r=>{if(r.url().includes(`/teams/${catalogTeamId}/roster-context`)&&r.status()===200)serverTimes.push((await r.json()).computedAt);});
 page.on('request',r=>{if(r.url().endsWith('/lineup-role-profiles'))requests.push(r.postDataJSON());});await open(page);
 const row=(i:number)=>card(page).getByRole('listitem').filter({has:page.getByRole('link',{name:'Synthetic member '+i,exact:true})});
 await expect(row(0)).toContainText('Offlane');await expect(row(0)).toContainText('Источники расходятся');await expect(row(0)).toContainText('нескольким игрокам');
 await expect(row(1)).toContainText('Mid');await expect(row(5)).toContainText('Роль не определена');
 await expect(card(page).getByRole('listitem').first()).toContainText('Mid');
 await row(1).getByText('Основания роли: Synthetic member 1',{exact:true}).click();await expect(row(1)).toContainText('устаревший кэш');await expect(row(1)).toContainText('Pro-карт с оценкой роли: 2');
 await expect(page.getByText('Слоты в протоколе карты',{exact:true})).toBeVisible();const slots=page.getByText('Номер слота не является ролью.',{exact:false});await expect(slots).toHaveCount(5);for(const slot of await slots.all())await expect(slot).not.toBeVisible();
 expect(requests.map(r=>r.playerIds.length)).toEqual([5,1]);expect(requests.every(r=>!r.refreshProfiles)).toBe(true);expect(profileCalls).toBe(0);
 expect(new Set(requests.map(r=>r.cutoffAt)).size).toBe(1);expect(serverTimes).toContain(requests[0]!.cutoffAt);
 await page.setViewportSize({width:360,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await card(page).screenshot({path:'test-results/roster-card-roles-mobile.png'});
 expect((await sql<{n:number}>`SELECT count(*)::int n FROM prediction_runs`.execute(database.db)).rows[0]!.n).toBe(0);expect(errors).toEqual([]);
});
test('partial roster reads one player, same membership reuses role cache, failed reread remains unknown until retry',async({page})=>{
 memberCount=1;let calls=0;page.on('request',r=>{if(r.url().endsWith('/lineup-role-profiles')){calls++;expect(r.postDataJSON().playerIds).toEqual([catalogPlayerId]);}});await open(page);
 await expect(card(page)).toContainText('Offlane');expect(calls).toBe(1);
 await card(page).getByRole('button',{name:'Обновить из OpenDota',exact:true}).click();await expect(card(page).getByRole('button',{name:'Обновить из OpenDota',exact:true})).toBeEnabled();expect(calls).toBe(1);
 await page.route('**/lineup-role-profiles',r=>r.fulfill({status:503,json:{error:{code:'SYNTHETIC_FAILURE',message:'synthetic'}}}));await page.reload();await expect(card(page).getByRole('alert')).toBeVisible();await expect(card(page)).toContainText('Роль не определена');await expect(card(page)).not.toContainText('Offlane');
 await page.unroute('**/lineup-role-profiles');await card(page).getByRole('button',{name:'Повторить чтение ролей',exact:true}).click();await expect(card(page)).toContainText('Offlane');expect(profileCalls).toBe(0);
});
