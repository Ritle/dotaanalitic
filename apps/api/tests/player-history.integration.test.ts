import {randomBytes,randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {sql,IdentityRepository,PlayerHistoryRepository,playerHistoryKey} from '@dota/db';
import {createPlayerHistoryQueue,enqueuePlayerHistory,registerPlayerHistoryWorker,executePlayerHistory,PLAYER_HISTORY_QUEUE} from '@dota/ingestion';
import {PlayerHistoryResponseSchema} from '@dota/contracts';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {syntheticPlayerHistory} from '../../../tests/helpers/player-history.js';
import {buildApp} from '../src/app.js';import {readConfig} from '../src/config.js';import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:Awaited<ReturnType<typeof buildApp>>,boss:Awaited<ReturnType<typeof createPlayerHistoryQueue>>,cookie:string,csrf:string,owner:string;
const ids=['1','2','3','4','5'],path='/api/v1/players/history-refresh',calls:string[]=[];
let release:()=>void=()=>undefined;
const get=(players=ids,options?:{windowDays:number;maxMaps:number})=>app.inject({url:path+'?playerIds='+players.join(',')+(options?`&windowDays=${options.windowDays}&maxMaps=${options.maxMaps}`:''),headers:{cookie}});
const post=(players=ids,options?:{windowDays:number;maxMaps:number})=>app.inject({method:'POST',url:path,headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload:{playerIds:players,...options}});
beforeAll(async()=>{database=await testDatabase();const password=randomBytes(24).toString('base64url');owner=(await new AuthService(database.db).provision('synthetic-player-history',password)).id;
 for(let i=1;i<=6;i++){await sql`INSERT INTO players(id,nickname) VALUES(${i},${'Synthetic '+i})`.execute(database.db);
  await new IdentityRepository(database.db).appendAccountEvidence({playerId:String(i),externalAccountId:String(1000+i),provider:'opendota',status:'verified',eventAt:null,knownAt:null,fetchedAt:new Date().toISOString(),evidenceRef:'synthetic:player-history-'+i,source:'synthetic'});}
 app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-player-history',password}}),cookies=login.headers['set-cookie'];
 cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');csrf=login.json().csrfToken;boss=await createPlayerHistoryQueue(database.url);
},30000);
afterAll(async()=>{release();await boss?.stop({graceful:true,timeout:10000});await app?.close();await database?.close();},30000);
it('requires owner/CSRF and exactly five verified accounts; GET does not contact providers',async()=>{
 expect((await app.inject(path+'?playerIds=1,2,3,4,5')).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:path,headers:{cookie,origin:'http://localhost:5173'},payload:{playerIds:ids}})).statusCode).toBe(403);
 expect((await post(['1','1','3','4','5'])).statusCode).toBe(400);expect((await get(['1','2'])).statusCode).toBe(400);
 expect((await post(['1','2','3','4','999'])).json()).toMatchObject({available:false,run:null});
 const r=await get();expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({available:true,run:null});expect(r.headers['cache-control']).toBe('no-store');expect(calls).toHaveLength(0);
});
it('deduplicates simultaneous and reordered selections, and imports personal history without organizations',async()=>{
 const posts=await Promise.all([post(),post([...ids].reverse()),post()]);expect(posts.every(r=>r.statusCode===202)).toBe(true);
 const run=posts[0]!.json().run.id;expect(new Set(posts.map(r=>r.json().run.id)).size).toBe(1);
 const gate=new Promise<void>(r=>release=r);await registerPlayerHistoryWorker(boss,database.db,()=>syntheticPlayerHistory({gate,onCall:name=>calls.push(name)}));
 for(let i=0;i<50&&(await get()).json().run.status!=='running';i++)await new Promise(r=>setTimeout(r,100));
 expect((await post()).json().run.id).toBe(run);release();
 let r;for(let i=0;i<60;i++){r=PlayerHistoryResponseSchema.parse((await get()).json());if(r.run?.finishedAt)break;await new Promise(r=>setTimeout(r,100));}
 expect(r?.run).toMatchObject({status:'completed',report:{selected:2,accepted:2,duplicates:0,excluded:0,failed:0}});expect(r?.run?.report?.players.every(p=>p.accepted===2)).toBe(true);
 expect(calls).toHaveLength(5);expect(calls.filter(c=>c.includes('/matches/'))).toHaveLength(2);expect(r?.retryAt).not.toBeNull();
 expect((await sql`SELECT id FROM teams`.execute(database.db)).rows).toHaveLength(0);
 expect((await sql`SELECT id FROM matches WHERE is_pro IS TRUE`.execute(database.db)).rows).toHaveLength(2);
 expect((await sql`SELECT player_id FROM match_players WHERE player_id=ANY(${ids}::bigint[])`.execute(database.db)).rows).toHaveLength(10);
 expect((await post()).json().run.id).toBe(run);expect(calls).toHaveLength(5);
});
it('idempotent replay keeps map revisions, skips completed runs, and reuses references per batch',async()=>{
 await boss.offWork(PLAYER_HISTORY_QUEUE);const repo=new PlayerHistoryRepository(database.db),bindings=(await repo.bindings(ids))!,before=(await sql`SELECT id,data_revision FROM matches ORDER BY id`.execute(database.db)).rows;
 const prior=(await repo.latest(owner,playerHistoryKey(bindings)))!;await executePlayerHistory(database.db,prior.id,2,syntheticPlayerHistory({onCall:n=>calls.push(n)}));expect(calls).toHaveLength(5);
 await sql`UPDATE player_history_runs SET next_allowed_at=clock_timestamp()-interval '1 second'`.execute(database.db);
 const id=(await post()).json().run.id;await executePlayerHistory(database.db,id,1,syntheticPlayerHistory());await boss.cancel(PLAYER_HISTORY_QUEUE,id);const r=await repo.get(id);
 expect(r?.report).toMatchObject({accepted:2,duplicates:2});expect((await sql`SELECT id,data_revision FROM matches ORDER BY id`.execute(database.db)).rows).toEqual(before);
});
it('source detail failures and excluded leagues remain partial and cannot import unchecked maps',async()=>{
 for(const mode of ['partial','excluded'] as const){await sql`UPDATE player_history_runs SET next_allowed_at=clock_timestamp()-interval '1 second'`.execute(database.db);
  const id=(await post()).json().run.id;await executePlayerHistory(database.db,id,1,syntheticPlayerHistory({mode}));await boss.cancel(PLAYER_HISTORY_QUEUE,id);const row=await new PlayerHistoryRepository(database.db).get(id);
  expect(row?.status).toBe('partial');expect(row?.report).toMatchObject(mode==='partial'?{accepted:1,failed:1}:{accepted:0,excluded:2});}
 expect((await sql`SELECT id FROM matches WHERE is_pro IS TRUE`.execute(database.db)).rows).toHaveLength(2);
});
it('keeps empty discovery explicit without inventing maps or player experience',async()=>{
 await sql`UPDATE player_history_runs SET next_allowed_at=clock_timestamp()-interval '1 second'`.execute(database.db);
 const id=(await post()).json().run.id;await executePlayerHistory(database.db,id,1,syntheticPlayerHistory({mode:'empty'}));await boss.cancel(PLAYER_HISTORY_QUEUE,id);
 const r=PlayerHistoryResponseSchema.parse((await get()).json());expect(r.run).toMatchObject({status:'completed',report:{selected:0,accepted:0,failed:0}});
 expect(r.message).toContain('не означает отсутствие');expect(r.run?.report?.players.every(p=>p.discovered===0&&p.accepted===0)).toBe(true);
});
it('rolls back run when queue rejects, reconciles cancelled jobs and fences stale attempts',async()=>{
 await sql`UPDATE player_history_runs SET next_allowed_at=clock_timestamp()-interval '1 second'`.execute(database.db);
 const repo=new PlayerHistoryRepository(database.db),bindings=(await repo.bindings(ids))!,before=(await sql`SELECT id FROM player_history_runs`.execute(database.db)).rows;
 const spy=vi.spyOn(boss,'send').mockResolvedValueOnce(null);try{await expect(enqueuePlayerHistory(boss,database.db,owner,bindings)).rejects.toThrow();}finally{spy.mockRestore();}
 expect((await sql`SELECT id FROM player_history_runs`.execute(database.db)).rows).toEqual(before);
 const id=await enqueuePlayerHistory(boss,database.db,owner,bindings),old=randomUUID(),next=randomUUID();await repo.start(id,old,1);await repo.start(id,next,2);
 expect(await repo.active(id,old)).toBe(false);await repo.finish(id,old,'completed',null,null);expect((await repo.get(id))?.status).toBe('running');
 await boss.cancel(PLAYER_HISTORY_QUEUE,id);expect((await get()).json().run).toMatchObject({status:'error',errorCode:'worker_unavailable'});
});
it('keeps period/depth caches distinct, blocks overlapping options, imports three bounded pages and validates limits',async()=>{
 expect((await post(ids,{windowDays:10000,maxMaps:25})).statusCode).toBe(400);expect((await post(ids,{windowDays:365,maxMaps:500})).statusCode).toBe(400);
 expect((await get(ids,{windowDays:365,maxMaps:11})).statusCode).toBe(400);
 const options={windowDays:365,maxMaps:25},old=(await get()).json().run.id;
 expect((await get(ids,options)).json().run).toBeNull();const queued=await post(ids,options);expect(queued.statusCode).toBe(202);const id=queued.json().run.id;
 expect(id).not.toBe(old);expect((await get()).json().run.id).toBe(old);expect((await post(ids,{windowDays:730,maxMaps:50})).statusCode).toBe(409);
 expect((await post([...ids].reverse(),options)).json().run.id).toBe(id);
 const requests:string[]=[];await executePlayerHistory(database.db,id,1,syntheticPlayerHistory({maps:25,onCall:name=>requests.push(name)}));await boss.cancel(PLAYER_HISTORY_QUEUE,id);
 const r=PlayerHistoryResponseSchema.parse((await get(ids,options)).json());expect(r.run).toMatchObject({status:'completed',report:{options,selected:25,accepted:25,discoveryPages:3}});
 expect(requests.filter(r=>r==='discover')).toHaveLength(3);expect(requests.filter(r=>r.includes('/matches/'))).toHaveLength(25);
 expect(r.run?.report?.players.every(p=>p.discovered===25&&p.sourceLimitReached===true)).toBe(true);
 expect((await post(ids,options)).json().run.id).toBe(id);expect((await sql`SELECT id FROM matches`.execute(database.db)).rows).toHaveLength(25);
 expect((await new PlayerHistoryRepository(database.db).get(id))?.source_audit).toMatchObject({options});
});
it('rechecks current numeric identity before source calls when queued bindings change',async()=>{
 await sql`UPDATE player_history_runs SET next_allowed_at=clock_timestamp()-interval '1 second'`.execute(database.db);const id=(await post()).json().run.id;
 await new IdentityRepository(database.db).appendAccountEvidence({playerId:'6',externalAccountId:'1001',provider:'opendota',status:'verified',eventAt:null,knownAt:null,fetchedAt:new Date().toISOString(),evidenceRef:'synthetic:conflict',source:'synthetic'});
 let n=0;await executePlayerHistory(database.db,id,1,syntheticPlayerHistory({onCall:()=>n++}));expect(n).toBe(0);
 expect(await new PlayerHistoryRepository(database.db).get(id)).toMatchObject({status:'error',error_code:'identity_changed'});
});
