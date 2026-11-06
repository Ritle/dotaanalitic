import {randomBytes,createHash} from 'node:crypto';
import {beforeEach,afterEach,test,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {sql,SchedulePageRepository} from '@dota/db';
import {SchedulePageResponseSchema,UpcomingScheduleResponseSchema,schedulePageEndpoint} from '@dota/contracts';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {scheduleToken,syntheticSchedule,syntheticRosters} from '../../../tests/helpers/upcoming.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
import {UpcomingService} from '../src/modules/upcoming/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,csrf:string,calls:string[],failure:boolean,echo:boolean,duplicateSecond:boolean;
let waitForFetch:(()=>Promise<void>)|null;
const schedule=(page:number)=>syntheticSchedule().map(m=>({...m,id:70000+(duplicateSecond&&page===2?1:page),name:`Synthetic page ${page}`,
 tournament:{id:71000+page,name:`Synthetic tournament ${page}`}}));
beforeEach(async()=>{
 database=await testDatabase();calls=[];failure=false;echo=false;duplicateSecond=false;waitForFetch=null;const password=randomBytes(24).toString('hex');
 await new AuthService(database.db).provision('synthetic-pages',password);
 app=await buildApp(readConfig({DATABASE_URL:database.url,PANDASCORE_API_TOKEN:scheduleToken}),{db:database.db,logger:false,
  catalogueProvider:async()=>{throw Error('Synthetic catalogue unavailable');},pandascoreFetch:async url=>{
   calls.push(url.pathname+url.search);await waitForFetch?.();
   const rows=url.pathname.endsWith('/rosters')?syntheticRosters():schedule(Number(url.searchParams.get('page')));
   return new Response(JSON.stringify(failure?{error:scheduleToken}:echo?[{...schedule(2)[0],name:scheduleToken}]:rows),{status:failure?429:200,headers:failure?{'Retry-After':'120'}:{}});
  }});
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-pages',password}});
 const value=login.headers['set-cookie'];cookie=(Array.isArray(value)?value:[value??'']).map(v=>v.split(';')[0]).join('; ');csrf=login.json().csrfToken;
},30000);
afterEach(async()=>{await app?.close();await database?.close();},30000);
const get=(page=2)=>app.inject({method:'GET',url:`/api/v1/upcoming?page=${page}`,headers:{cookie}});
const post=(url:string)=>app.inject({method:'POST',url,headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload:{}});
const refresh=(page=2)=>post(`/api/v1/upcoming/refresh?page=${page}`);
const budget=()=>sql`UPDATE pandascore_request_quota SET next_request_at='-infinity'`.execute(database.db);
test('GET is cache-only and malformed, unauthorized and CSRF-less page requests never reach the provider',async()=>{
 expect((await app.inject({method:'GET',url:'/api/v1/upcoming?page=2'})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:'/api/v1/upcoming/refresh?page=2',headers:{cookie},payload:{}})).statusCode).toBe(403);
 expect((await get()).json()).toMatchObject({snapshot:null,reason:'not_loaded'});
 for(const query of ['page=0','page=51','page=01','page=1.5','page=1e1','page=','page=2&page=3','page=2&per_page=100']){
  expect((await app.inject({method:'GET',url:'/api/v1/upcoming?'+query,headers:{cookie}})).statusCode).toBe(400);
  expect((await post('/api/v1/upcoming/refresh?'+query)).statusCode).toBe(400);
 }
 expect(calls).toEqual([]);
});
test('pages have independent persisted cache and receipts; repeats reuse cache without altering frozen page-one evidence',async()=>{
 const first=UpcomingScheduleResponseSchema.parse((await refresh(1)).json());await budget();
 const second=SchedulePageResponseSchema.parse((await refresh()).json());
 expect(second.snapshot!.source.endpoint).toBe(schedulePageEndpoint(2));expect(second.snapshot!.data[0]!.providerMatchId).toBe('70002');
 expect((await get(1)).json().snapshot).toEqual(first.snapshot);await refresh();await get();
 expect((await new UpcomingService(database.db,scheduleToken).schedule(false,2)).snapshot).toEqual(second.snapshot);
 expect(calls).toEqual([schedulePageEndpoint(1),schedulePageEndpoint(2)]);
 const rows=(await sql<{page:number;snapshot_text:string;snapshot_sha256:string;source_endpoint:string}>`SELECT * FROM upcoming_page_observations`.execute(database.db)).rows;
 expect(rows).toHaveLength(1);expect(rows[0]!.source_endpoint).toBe(schedulePageEndpoint(2));
 expect(rows[0]!.snapshot_sha256).toBe(createHash('sha256').update(rows[0]!.snapshot_text).digest('hex'));
 expect((await sql`SELECT cache_key FROM upcoming_source_observations`.execute(database.db)).rows).toEqual([{cache_key:'schedule'}]);
 await expect(sql`DELETE FROM upcoming_page_observations`.execute(database.db)).rejects.toThrow();
 await expect(sql`UPDATE upcoming_page_observations SET page=3`.execute(database.db)).rejects.toThrow();
 expect((await sql`SELECT id FROM matches`.execute(database.db)).rows).toEqual([]);
});
test('a tournament and catalogue on page two can be read and refreshed, without authorizing an unobserved tournament',async()=>{
 await refresh();await budget();const path='/api/v1/upcoming/tournaments/71002';
 expect((await post(path+'/refresh')).statusCode).toBe(200);
 const state=await app.inject({method:'GET',url:'/api/v1/upcoming/70002/catalogue',headers:{cookie}});
 expect(state.statusCode).toBe(200);expect(state.json().teams.map((t:{players:unknown[]})=>t.players.length)).toEqual([6,5]);
 expect((await post('/api/v1/upcoming/tournaments/999/refresh')).statusCode).toBe(404);
 expect(calls).toEqual([schedulePageEndpoint(2),'/tournaments/71002/rosters']);
});
test('stale page survives failure and shared Retry-After blocks requests to other pages',async()=>{
 const old=(await refresh()).json().snapshot;await sql`UPDATE upcoming_page_cache SET expires_at=clock_timestamp()-interval '1 second'`.execute(database.db);await budget();failure=true;
 const response=await refresh();expect(response.json()).toMatchObject({status:'stale',reason:'source_unavailable',snapshot:old});expect(response.body).not.toContain(scheduleToken);
 expect(Date.parse(response.json().retryAt)-Date.parse(response.json().computedAt)).toBeGreaterThan(110000);
 await refresh();await refresh(3);await get();expect(calls).toHaveLength(2);
});
test('concurrent refresh issues one provider request while a second caller sees the lease',async()=>{
 let start!:()=>void,release!:()=>void;const started=new Promise<void>(r=>start=r),pending=new Promise<void>(r=>release=r);
 waitForFetch=async()=>{start();await pending;};const first=refresh().then(r=>r);await started;
 try{expect((await refresh()).json()).toMatchObject({refreshing:true,reason:'refresh_in_progress'});}finally{release();}
 expect((await first).json().status).toBe('ready');expect(calls).toHaveLength(1);
});
test('wrong endpoints, future clocks, duplicate IDs and reflected credentials are not returned or used for catalogue context',async()=>{
 const valid=(await refresh()).json().snapshot;
 for(const changed of [{...valid,source:{...valid.source,endpoint:schedulePageEndpoint(3)}},{...valid,source:{...valid.source,fetchedAt:new Date(Date.now()+86400000).toISOString()}},
  {...valid,data:[...valid.data,...valid.data]},{...valid,data:[{...valid.data[0],name:scheduleToken}]}]){
  await sql`UPDATE upcoming_page_cache SET payload=${JSON.stringify(changed)}::jsonb`.execute(database.db);
  const response=await get();expect(response.json()).toMatchObject({snapshot:null,reason:'invalid_cached_data'});expect(response.body).not.toContain(scheduleToken);
  expect(await new UpcomingService(database.db,scheduleToken).findMatch('70002')).toBeUndefined();
 }
 await sql`UPDATE upcoming_page_cache SET expires_at=clock_timestamp()-interval '1 second'`.execute(database.db);await budget();echo=true;
 expect((await refresh()).json().snapshot).toBeNull();expect((await sql`SELECT id FROM upcoming_page_observations`.execute(database.db)).rows).toHaveLength(1);
});
test('expired lease writers cannot replace a newer observation or append duplicate evidence',async()=>{
 const snapshot=(await refresh()).json().snapshot,repo=new SchedulePageRepository(database.db);
 await sql`UPDATE upcoming_page_cache SET expires_at=clock_timestamp()-interval '1 second'`.execute(database.db);
 const old=(await repo.claim(2))!;await sql`UPDATE upcoming_page_cache SET lease_until=clock_timestamp()-interval '1 second'`.execute(database.db);
 const current=(await repo.claim(2))!;await repo.publish(2,current,snapshot);await repo.publish(2,old,{...snapshot,data:[]});
 expect((await get()).json().snapshot).toEqual(snapshot);expect((await sql`SELECT id FROM upcoming_page_observations`.execute(database.db)).rows).toHaveLength(2);
});
test('a match moving between pages uses its newest observed context without merging page snapshots',async()=>{
 duplicateSecond=true;await refresh(1);await budget();await refresh(2);
 const service=new UpcomingService(database.db,scheduleToken),current=await service.findMatch('70001');
 expect(current).toMatchObject({name:'Synthetic page 2',tournament:{providerTournamentId:'71002'}});
 expect((await get(1)).json().snapshot.data[0].name).toBe('Synthetic page 1');
 expect((await get(2)).json().snapshot.data[0].name).toBe('Synthetic page 2');expect(calls).toHaveLength(2);
});
