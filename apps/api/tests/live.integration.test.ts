import {randomBytes} from 'node:crypto';
import {beforeEach,afterEach,test,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {sql} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {syntheticSchedule,scheduleToken} from '../../../tests/helpers/upcoming.js';
import {buildApp} from '../src/app.js';import {readConfig} from '../src/config.js';import {AuthService} from '../src/modules/auth/service.js';
import {LiveScheduleRepository} from '../src/modules/live/repository.js';
import {LiveScheduleService} from '../src/modules/live/service.js';
import {LIVE_ENDPOINT} from '../src/modules/live/contract.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,csrf:string,calls:number,mode:'normal'|'failed'|'empty'|'echo';
beforeEach(async()=>{
 database=await testDatabase();calls=0;mode='normal';const password=randomBytes(20).toString('hex');await new AuthService(database.db).provision('synthetic-live',password);
 app=await buildApp(readConfig({DATABASE_URL:database.url,PANDASCORE_API_TOKEN:scheduleToken}),{db:database.db,logger:false,pandascoreFetch:async url=>{
  calls++;expect(url.pathname).toBe('/dota2/matches/running');if(mode==='failed')return new Response('{}',{status:403});
  return new Response(JSON.stringify(mode==='empty'?[]:[{...syntheticSchedule()[0],name:mode==='echo'?scheduleToken:'Synthetic live',status:'running',results:[{team_id:74002,score:0},{team_id:74001,score:1}]}]));
 }});
 const r=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-live',password}});const c=r.headers['set-cookie'];cookie=(Array.isArray(c)?c:[c??'']).map(v=>v.split(';')[0]).join('; ');csrf=r.json().csrfToken;
},30000);
afterEach(async()=>{await app?.close();await database?.close();},30000);
const get=()=>app.inject({method:'GET',url:'/api/v1/live',headers:{cookie}});
const refresh=()=>app.inject({method:'POST',url:'/api/v1/live/refresh',headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload:{}});
const expire=async()=>{await sql`UPDATE live_schedule_cache SET expires_at=clock_timestamp()-interval '1 second',retry_at='-infinity'`.execute(database.db);await sql`UPDATE pandascore_request_quota SET next_request_at='-infinity',blocked_until='-infinity'`.execute(database.db);};
test('auth, CSRF and owner permissions guard refresh; GET never contacts provider',async()=>{
 expect((await app.inject({method:'GET',url:'/api/v1/live'})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:'/api/v1/live/refresh',headers:{cookie,origin:'http://localhost:5173'},payload:{}})).statusCode).toBe(403);
 expect((await get()).json()).toMatchObject({snapshot:null,reason:'not_loaded'});expect(calls).toBe(0);
 await sql`UPDATE app_users SET account_role='user'`.execute(database.db);expect((await refresh()).statusCode).toBe(403);expect((await get()).statusCode).toBe(200);expect(calls).toBe(0);
});
test('concurrent refreshes share one lease; cached read, stale failure, cooldown and empty replacement work',async()=>{
 await Promise.all([refresh(),refresh()]);expect(calls).toBe(1);const first=(await get()).json();expect(first.status).toBe('ready');expect(first.snapshot.data[0].seriesScore[0].wins).toBe(1);
 await refresh();expect(calls).toBe(1);await expire();mode='failed';const failed=(await refresh()).json();expect(failed).toMatchObject({status:'stale',reason:'source_unavailable',snapshot:first.snapshot});expect(failed.retryAt).toBeTruthy();await refresh();expect(calls).toBe(2);
 await expire();mode='empty';expect((await refresh()).json()).toMatchObject({status:'ready',snapshot:{data:[]}});expect(calls).toBe(3);
 expect((await sql`SELECT count(*)::int n FROM matches`.execute(database.db)).rows[0]!.n).toBe(0);
 expect((await sql`SELECT count(*)::int n FROM upcoming_source_cache`.execute(database.db)).rows[0]!.n).toBe(0);
});
test('credential echo is never persisted or returned; an expired lease cannot publish',async()=>{
 expect(await new LiveScheduleService(database.db).read(true)).toMatchObject({configured:false,reason:'not_configured'});expect(calls).toBe(0);
 mode='echo';const r=await refresh();expect(r.body).not.toContain(scheduleToken);expect(r.json()).toMatchObject({snapshot:null,reason:'source_unavailable'});
 expect((await sql`SELECT payload FROM live_schedule_cache`.execute(database.db)).rows[0]!.payload).toBeNull();
 await sql`UPDATE live_schedule_cache SET retry_at='-infinity'`.execute(database.db);const repository=new LiveScheduleRepository(database.db),token=await repository.claim();expect(token).toBeTruthy();
 await sql`UPDATE live_schedule_cache SET lease_until=clock_timestamp()-interval '1 second'`.execute(database.db);
 await repository.publish(token!,{data:[],source:{provider:'pandascore',adapterVersion:'pandascore-running-v1',endpoint:LIVE_ENDPOINT,fetchedAt:new Date().toISOString(),knownAt:null,payloadSha256:'a'.repeat(64),attempts:1,rateLimitRemaining:null}});
 expect((await sql`SELECT payload FROM live_schedule_cache`.execute(database.db)).rows[0]!.payload).toBeNull();
});
