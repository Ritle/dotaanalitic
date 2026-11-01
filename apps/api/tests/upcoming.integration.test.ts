import {randomBytes} from 'node:crypto';
import {createHash} from 'node:crypto';
import {beforeEach,afterEach,test,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {sql,ScheduleCacheRepository,PandaScoreQuotaRepository} from '@dota/db';
import {UpcomingScheduleResponseSchema} from '@dota/contracts';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {scheduleToken,syntheticSchedule,syntheticRosters} from '../../../tests/helpers/upcoming.js';
import {buildApp} from '../src/app.js';import {readConfig} from '../src/config.js';import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string,csrf:string,calls:string[],failure:boolean,echo:boolean;
const cookieSecret='synthetic-upcoming-persistent-cookie-secret';
const fetcher=async(url:URL)=>{calls.push(url.pathname);return new Response(JSON.stringify(failure?{error:scheduleToken}:
  url.pathname.endsWith('/rosters')?syntheticRosters():echo?[{...syntheticSchedule()[0],name:scheduleToken}]:syntheticSchedule()),{status:failure?403:200});};
beforeEach(async()=>{
  database=await testDatabase();calls=[];failure=false;echo=false;const password=randomBytes(20).toString('hex');
  await new AuthService(database.db).provision('synthetic-upcoming',password);
  app=await buildApp(readConfig({DATABASE_URL:database.url,PANDASCORE_API_TOKEN:scheduleToken,AUTH_COOKIE_SECRET:cookieSecret}),{db:database.db,logger:false,pandascoreFetch:fetcher});
  const r=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-upcoming',password}});
  const c=r.headers['set-cookie'];cookie=(Array.isArray(c)?c:[c??'']).map(v=>v.split(';')[0]).join('; ');csrf=r.json().csrfToken;
},30000);
afterEach(async()=>{await app?.close();await database?.close();},30000);
const get=(url='/api/v1/upcoming')=>app.inject({method:'GET',url,headers:{cookie}});
const refresh=(url='/api/v1/upcoming/refresh')=>app.inject({method:'POST',url,headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload:{}});
const expire=async()=>{await sql`UPDATE upcoming_source_cache SET expires_at=clock_timestamp()-interval '1 second' WHERE payload IS NOT NULL`.execute(database.db);
  await sql`UPDATE pandascore_request_quota SET next_request_at='-infinity'`.execute(database.db);};
test('auth/CSRF guard provider access, GET is cache-only, missing token stays useful unavailable',async()=>{
  expect((await app.inject({method:'GET',url:'/api/v1/upcoming'})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:'/api/v1/upcoming/refresh',headers:{cookie,origin:'http://localhost:5173'},payload:{}})).statusCode).toBe(403);
  const r=await get();expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('no-store');expect(r.json()).toMatchObject({status:'unavailable',reason:'not_loaded',snapshot:null});expect(calls).toHaveLength(0);
  await app.close();app=await buildApp(readConfig({DATABASE_URL:database.url,AUTH_COOKIE_SECRET:cookieSecret}),{db:database.db,logger:false,pandascoreFetch:fetcher});
  const s=await refresh();expect(s.json()).toMatchObject({configured:false,reason:'not_configured',snapshot:null});expect(calls).toHaveLength(0);
});
test('real repository cache serves schema-checked data and avoids repeated provider calls',async()=>{
  const r=await refresh();expect(r.statusCode).toBe(200);const s=UpcomingScheduleResponseSchema.parse(r.json());
  expect(s.status).toBe('ready');expect(s.snapshot!.data[0]!.providerMatchId).toBe('70001');expect(r.body).not.toContain(scheduleToken);
  expect((await refresh()).json().snapshot).toEqual(s.snapshot);expect((await get()).json().snapshot).toEqual(s.snapshot);expect(calls).toHaveLength(1);
  expect((await sql`SELECT * FROM matches`.execute(database.db)).rows).toHaveLength(0);
});
test('successful provider refresh freezes a source observation without assigning a map lineup',async()=>{
  await refresh();
  const tournament='/api/v1/upcoming/tournaments/71001';
  await refresh(tournament+'/refresh');
  const read=()=>sql<{cache_key:string;source_fetched_at:Date;recorded_at:Date;source_payload_sha256:string;
    snapshot_sha256:string;snapshot_text:string}>`SELECT cache_key,source_fetched_at,recorded_at,source_payload_sha256,
    snapshot_sha256,snapshot_text FROM upcoming_source_observations ORDER BY id`.execute(database.db);
  const rows=(await read()).rows;
  expect(rows.map(r=>r.cache_key)).toEqual(['schedule','tournament:71001']);
  for(const row of rows){
    const snapshot=JSON.parse(row.snapshot_text);
    expect(row.source_fetched_at.getTime()).toBeLessThanOrEqual(row.recorded_at.getTime());
    expect(row.source_payload_sha256).toBe(snapshot.source.payloadSha256);
    expect(row.snapshot_sha256).toBe(createHash('sha256').update(row.snapshot_text).digest('hex'));
    expect(row.snapshot_text).not.toContain(scheduleToken);
  }
  expect(JSON.parse(rows[0]!.snapshot_text).data[0].scheduledAt).toBeDefined();
  expect(JSON.parse(rows[1]!.snapshot_text).data[0].players).toHaveLength(6);
  expect((await sql`SELECT count(*)::int AS n FROM matches`.execute(database.db)).rows[0]).toMatchObject({n:0});
  expect((await sql`SELECT count(*)::int AS n FROM scenarios`.execute(database.db)).rows[0]).toMatchObject({n:0});
  await refresh();await refresh(tournament+'/refresh');
  expect((await read()).rows).toHaveLength(2);
  await expect(sql`UPDATE upcoming_source_observations SET cache_key='schedule' WHERE cache_key='tournament:71001'`.execute(database.db)).rejects.toThrow();
  await expect(sql`DELETE FROM upcoming_source_observations`.execute(database.db)).rejects.toThrow();
});
test('tournament lookup stays within cached schedule and preserves all six expected players',async()=>{
  await refresh();const path='/api/v1/upcoming/tournaments/71001';expect((await get(path)).json().snapshot).toBeNull();
  const r=await refresh(path+'/refresh');expect(r.statusCode).toBe(200);expect(r.json().snapshot.data.map((t:{players:unknown[]})=>t.players.length)).toEqual([6,5]);
  expect(r.body).not.toContain('birthday');expect((await refresh(path+'/refresh')).json().snapshot).toEqual(r.json().snapshot);
  expect((await refresh('/api/v1/upcoming/tournaments/999/refresh')).statusCode).toBe(404);
  expect((await get('/api/v1/upcoming/tournaments/invalid')).statusCode).toBe(400);expect((await get('/api/v1/upcoming?token=wrong')).statusCode).toBe(400);
  expect(calls).toEqual(['/dota2/matches/upcoming','/tournaments/71001/rosters']);
});
test('stale snapshot survives provider failure and durable cooldown prevents retry storms',async()=>{
  const first=(await refresh()).json();await expire();failure=true;
  const r=await refresh();expect(r.json()).toMatchObject({status:'stale',reason:'source_unavailable'});expect(r.json().snapshot).toEqual(first.snapshot);expect(r.body).not.toContain(scheduleToken);
  expect(r.json().retryAt).not.toBeNull();const n=calls.length;await refresh();expect(calls).toHaveLength(n);
});
test('a reflected credential is rejected before caching or responding',async()=>{
  echo=true;const r=await refresh();expect(r.json().snapshot).toBeNull();expect(r.json().reason).toBe('source_unavailable');expect(r.body).not.toContain(scheduleToken);
  expect((await new ScheduleCacheRepository(database.db).read('schedule')).payload).toBeNull();
  expect((await sql`SELECT count(*)::int AS n FROM upcoming_source_observations`.execute(database.db)).rows[0]).toMatchObject({n:0});
});
test('concurrent refresh obtains one lease and lease replacement rejects a late writer',async()=>{
  const a=new ScheduleCacheRepository(database.db),b=new ScheduleCacheRepository(database.db);
  const claims=await Promise.all([a.claim('schedule'),b.claim('schedule')]);expect(claims.filter(Boolean)).toHaveLength(1);
  const old=claims.find(Boolean)!;await sql`UPDATE upcoming_source_cache SET lease_until=clock_timestamp()-interval '1 second'`.execute(database.db);
  const next=(await b.claim('schedule'))!;await a.publish('schedule',old,{old:true});expect((await a.read('schedule')).payload).toBeNull();
  await b.publish('schedule',next,{new:true});expect((await a.read('schedule')).payload).toEqual({new:true});await a.publish('schedule',old,{old:true});expect((await a.read('schedule')).payload).toEqual({new:true});
});
test('cache TTL uses database clock, busy refresh is visible and failed attempts keep persisted retry',async()=>{
  const c=new ScheduleCacheRepository(database.db),lease=(await c.claim('schedule'))!;
  expect((await get()).json()).toMatchObject({snapshot:null,refreshing:true,reason:'refresh_in_progress'});
  await c.fail('schedule',lease,120000);const r=(await get()).json();expect(r.retryAt).not.toBeNull();expect(r.refreshing).toBe(false);
  expect(await new ScheduleCacheRepository(database.db).claim('schedule')).toBeNull();
});
test('quota is atomic across instances, rolls hourly and keeps Retry-After/exhaustion across restarts',async()=>{
  const a=new PandaScoreQuotaRepository(database.db),b=new PandaScoreQuotaRepository(database.db);
  const claims=await Promise.all([a.claim(),b.claim()]);expect(claims.filter(c=>c.allowed)).toHaveLength(1);
  expect(claims.find(c=>!c.allowed)!.retryAfterMs).toBeGreaterThan(0);
  await sql`UPDATE pandascore_request_quota SET requests_used=900,next_request_at='-infinity'`.execute(database.db);
  expect((await b.claim()).allowed).toBe(false);
  await sql`UPDATE pandascore_request_quota SET hour_start=hour_start-interval '1 hour'`.execute(database.db);expect((await a.claim()).allowed).toBe(true);
  await a.observe(429,120000,null);expect((await new PandaScoreQuotaRepository(database.db).claim()).retryAfterMs).toBeGreaterThan(119000);
  await b.observe(200,null,0);expect((await a.claim()).retryAfterMs).toBeGreaterThan(3500000);
});
test('invalid cached payload never escapes the output schema',async()=>{
  const c=new ScheduleCacheRepository(database.db),t=(await c.claim('schedule'))!;await c.publish('schedule',t,{secret:scheduleToken});
  const r=await get();expect(r.json()).toMatchObject({snapshot:null,status:'unavailable',reason:'invalid_cached_data'});expect(r.body).not.toContain(scheduleToken);
});
test('cached observations bind the exact endpoint and cannot claim a future fetch time',async()=>{
  const first=(await refresh()).json().snapshot;
  for(const change of [{endpoint:'/tournaments/71001/rosters'},{fetchedAt:new Date(Date.now()+86400000).toISOString()}]){
    const payload={...first,source:{...first.source,...change}};
    await sql`UPDATE upcoming_source_cache SET payload=${JSON.stringify(payload)}::jsonb WHERE cache_key='schedule'`.execute(database.db);
    expect((await get()).json()).toMatchObject({snapshot:null,reason:'invalid_cached_data',status:'unavailable'});
  }
});
