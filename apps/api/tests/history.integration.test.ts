import {randomBytes,randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {sql,HistoryRefreshRepository} from '@dota/db';
import {createHistoryQueue,enqueueHistoryRefresh,registerHistoryWorker,HISTORY_QUEUE,OpenDotaError} from '@dota/ingestion';
import {HistoryRefreshResponseSchema} from '@dota/contracts';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {syntheticHistoryProvider} from '../../../tests/helpers/history-refresh.js';
import {buildApp} from '../src/app.js';import {readConfig} from '../src/config.js';import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,boss:Awaited<ReturnType<typeof createHistoryQueue>>,cookie:string,csrf:string,owner:string;
let mode:'ok'|'partial'|'fail'='ok',requests=0,transientFailures=0,release:()=>void=()=>undefined,gate:Promise<void>|undefined;
const path=(id='101')=>`/api/v1/teams/${id}/history-refresh`;
const get=(id='101')=>app.inject({url:path(id),headers:{cookie}});
const post=(id='101')=>app.inject({method:'POST',url:path(id),headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload:{}});
async function terminal(id:string){let result;for(let i=0;i<50;i++){
  const response=await get(id);expect(response.statusCode).toBe(200);result=HistoryRefreshResponseSchema.parse(response.json());
  if(result.run&&['completed','partial','error'].includes(result.run.status))return result;
  await new Promise(resolve=>setTimeout(resolve,200));}throw new Error('synthetic_history_timeout');}
beforeAll(async()=>{
  database=await testDatabase();
  await sql`INSERT INTO teams(id,opendota_team_id,name) VALUES (101,31,'Synthetic history A'),(102,NULL,'Synthetic unlinked'),
    (103,33,'Synthetic history partial'),(104,34,'Synthetic history failure'),(105,35,'Synthetic abandoned'),(106,36,'Synthetic rollback'),
    (107,37,'Synthetic retry')`.execute(database.db);
  const password=randomBytes(24).toString('base64url');owner=(await new AuthService(database.db).provision('synthetic-history-owner',password)).id;
  app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-history-owner',password}});
  const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');csrf=login.json().csrfToken;
  boss=await createHistoryQueue(database.url);
},30000);
afterAll(async()=>{release();await boss?.stop({graceful:true,timeout:10000});await app?.close();await database?.close();},30000);
it('requires owner, origin, CSRF and strict numeric/empty payloads; GET creates no job or source request',async()=>{
  expect((await app.inject(path())).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:path(),headers:{cookie,origin:'https://example.invalid'},payload:{}})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:path(),headers:{cookie,origin:'http://localhost:5173'},payload:{}})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:path(),headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload:{teamId:'103'}})).statusCode).toBe(400);
  expect((await get('invalid')).statusCode).toBe(400);expect((await get('999')).statusCode).toBe(404);
  const idle=await get();expect(idle.headers['cache-control']).toBe('no-store');expect(idle.json()).toMatchObject({available:true,run:null});
  expect((await get('102')).json()).toMatchObject({available:false,run:null});expect((await post('102')).json().run).toBeNull();
  expect((await sql`SELECT * FROM history_refresh_runs`.execute(database.db)).rows).toHaveLength(0);expect(requests).toBe(0);
});
it('commits one durable run/job across simultaneous POSTs, API restart and running clicks',async()=>{
  const starts=await Promise.all([post(),post(),post()]);expect(starts.every(r=>r.statusCode===202)).toBe(true);
  const ids=starts.map(r=>r.json().run.id);expect(new Set(ids).size).toBe(1);
  expect((await boss.getJobById(HISTORY_QUEUE,ids[0])).state).toBe('created');expect(requests).toBe(0);
  await app.close();app=await buildApp(readConfig({DATABASE_URL:database.url,AUTH_COOKIE_SECRET:'synthetic-history-restart-secret-32-characters'}),{db:database.db,logger:false});
  // Auth/me rotates CSRF under the new process-local key, as a browser reload does.
  const me=await app.inject({url:'/api/v1/auth/me',headers:{cookie}});const cookies=me.headers['set-cookie'];
  cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ')+'; '+cookie.split('; ').find(c=>c.startsWith('dota_session='));csrf=me.json().csrfToken;
  expect((await get()).json().run.id).toBe(ids[0]);gate=new Promise(resolve=>{release=resolve;});
  await registerHistoryWorker(boss,database.db,()=>{if(transientFailures>0){transientFailures--;throw new OpenDotaError('source_timeout');}
    return syntheticHistoryProvider({mode,gate,onRequest:()=>requests++});});
  for(let i=0;i<50&&(await get()).json().run.status!=='running';i++)await new Promise(r=>setTimeout(r,100));
  expect((await get()).json().run.status).toBe('running');expect((await post()).json().run.id).toBe(ids[0]);release();gate=undefined;
});
it('imports validated maps and exposes counts, timestamps, safe audit and a durable cooldown',async()=>{
  const r=await terminal('101');expect(r.run).toMatchObject({status:'completed',selected:2,processed:2,accepted:2,duplicates:0,sourceErrors:0});
  expect(r.run!.sourceFetchedAt).not.toBeNull();expect(r.retryAt).not.toBeNull();expect(requests).toBe(5);
  const report=await app.inject({url:'/api/v1/teams/101/matches',headers:{cookie}});expect(report.json().summary.nRaw).toBe(2);
  expect((await post()).json().run.id).toBe(r.run!.id);expect(requests).toBe(5);
  const row=await new HistoryRefreshRepository(database.db).get(r.run!.id);expect(row!.audits).toHaveLength(1);
  expect(JSON.stringify(row!.audits)).not.toMatch(/rawBody|players|password|Authorization/);
});
it('a new permitted refresh reuses exact maps and keeps revisions stable',async()=>{
  await sql`UPDATE history_refresh_runs SET next_allowed_at=clock_timestamp()-interval '1 second' WHERE team_id=101`.execute(database.db);
  const before=(await sql`SELECT id,data_revision FROM matches ORDER BY id`.execute(database.db)).rows;
  expect((await post()).statusCode).toBe(202);const r=await terminal('101');expect(r.run).toMatchObject({status:'completed',processed:2,duplicates:2});
  expect((await sql`SELECT id,data_revision FROM matches ORDER BY id`.execute(database.db)).rows).toEqual(before);
});
it('source partial failures retain accepted maps and expose partial status; permanent failures terminate safely',async()=>{
  mode='partial';expect((await post('103')).statusCode).toBe(202);const partial=await terminal('103');
  expect(partial.run).toMatchObject({status:'partial',selected:2,processed:1,sourceErrors:1,errorCode:'source_unavailable'});
  mode='fail';expect((await post('104')).statusCode).toBe(202);expect((await terminal('104')).run).toMatchObject({status:'error',errorCode:'source_unavailable'});
  mode='ok';
});
it('transient source failure retries the same durable run and completes with a new fenced attempt',async()=>{
  await boss.updateQueue(HISTORY_QUEUE,{retryDelay:1,retryBackoff:false});transientFailures=1;
  expect((await post('107')).statusCode).toBe(202);const r=await terminal('107');
  expect(r.run).toMatchObject({status:'completed',attempt:2,processed:2,errorCode:null});
  expect((await sql`SELECT * FROM history_refresh_runs WHERE team_id=107`.execute(database.db)).rows).toHaveLength(1);
});
it('cancelled/lost jobs become visible errors and stale attempt tokens cannot change terminal progress',async()=>{
  await boss.offWork(HISTORY_QUEUE);const id=await enqueueHistoryRefresh(boss,database.db,owner,'105');expect(id).not.toBeNull();
  const repo=new HistoryRefreshRepository(database.db),token=randomUUID();await repo.start(id!,token,1);await boss.cancel(HISTORY_QUEUE,id!);
  const next=randomUUID();expect(await repo.start(id!,next,2)).not.toBeNull();expect(await repo.start(id!,token,1)).toBeNull();
  expect(await repo.progress(id!,token,{processed:1,accepted:1,duplicates:0,conflicts:0})).toBe(false);
  const result=await get('105');expect(result.json().run).toMatchObject({status:'error',errorCode:'worker_unavailable'});
  expect(await repo.progress(id!,token,{processed:1,accepted:1,duplicates:0,conflicts:0})).toBe(false);
});
it('queue enqueue failure rolls back its run row instead of leaving a permanently queued request',async()=>{
  const send=vi.spyOn(boss,'send').mockResolvedValueOnce(null);
  try{await expect(enqueueHistoryRefresh(boss,database.db,owner,'106')).rejects.toThrow('history_job_conflict');}
  finally{send.mockRestore();}
  expect((await sql`SELECT * FROM history_refresh_runs WHERE team_id=106`.execute(database.db)).rows).toHaveLength(0);
});
