import {randomBytes,randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {sql,IdentityRepository,PlayerHistoryRepository,PlayerHistoryResumeRepository,V1DataRepository} from '@dota/db';
import {readV1RuntimeCode} from '../../../packages/db/dist/v1-runtime-code.js';
import {createPlayerHistoryQueue,enqueuePlayerHistory,enqueuePlayerHistoryResume,executePlayerHistory,PLAYER_HISTORY_QUEUE,OpenDotaClient} from '@dota/ingestion';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {syntheticPlayerHistory} from '../../../tests/helpers/player-history.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,boss:Awaited<ReturnType<typeof createPlayerHistoryQueue>>,app:FastifyInstance,owner:string,rootId:string,cookie:string,csrf:string;
const ids:string[]=[],originalCalls:string[]=[],resumeCalls:string[]=[];
const headers=()=>({cookie,origin:'http://localhost:5173','x-csrf-token':csrf});
const post=(runId=rootId)=>app.inject({method:'POST',url:'/api/v1/players/history-refresh/resume',headers:headers(),payload:{runId}});
beforeAll(async()=>{
 database=await testDatabase();const password=randomBytes(24).toString('base64url');owner=(await new AuthService(database.db).provision('synthetic-resume',password)).id;
 for(let i=0;i<5;i++){const id=(await sql<{id:string}>`INSERT INTO players(nickname) VALUES(${'Synthetic '+i}) RETURNING id`.execute(database.db)).rows[0]!.id;ids.push(id);
  await new IdentityRepository(database.db).appendAccountEvidence({playerId:id,externalAccountId:String(1001+i),provider:'opendota',status:'verified',eventAt:null,knownAt:null,fetchedAt:new Date().toISOString(),source:'synthetic',evidenceRef:'synthetic resume owner'});}
 boss=await createPlayerHistoryQueue(database.url);app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-resume',password}}),cookies=login.headers['set-cookie'];
 cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');csrf=login.json().csrfToken;
 const repo=new PlayerHistoryRepository(database.db),bindings=(await repo.bindings(ids))!;rootId=await enqueuePlayerHistory(boss,database.db,owner,bindings);
 const {getProPlayers:_,...initial}=syntheticPlayerHistory({enrichment:true,onCall:p=>originalCalls.push(p)});
 await executePlayerHistory(database.db,rootId,1,initial);await boss.cancel(PLAYER_HISTORY_QUEUE,rootId);
},30000);
afterAll(async()=>{await app?.close();await boss?.stop({graceful:true,timeout:10000});await database?.close();},30000);
it('requires owner/CSRF, a valid owned terminal source and respects the normal cooldown',async()=>{
 expect((await app.inject({method:'POST',url:'/api/v1/players/history-refresh/resume',payload:{runId:rootId}})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:'/api/v1/players/history-refresh/resume',headers:{cookie,origin:'http://localhost:5173'},payload:{runId:rootId}})).statusCode).toBe(403);
 expect((await post(randomUUID())).statusCode).toBe(409);
 expect((await app.inject({method:'POST',url:'/api/v1/players/history-refresh/resume',headers:headers(),payload:{runId:rootId,matchIds:['99000001']}})).statusCode).toBe(400);
 const blocked=await post();expect(blocked.statusCode).toBe(202);expect(blocked.json().run.id).toBe(rootId);
 expect((await sql`SELECT id FROM player_history_runs`.execute(database.db)).rows).toHaveLength(1);
});
it('resumes a captured scope without discovery, details or references HTTP, preserving original reports/receipts',async()=>{
 const repo=new PlayerHistoryRepository(database.db),old=await repo.get(rootId);expect(old?.report).toMatchObject({enrichment:{unresolvedAccounts:['1006','1007','1008','1009','1010']}});
 const originals=(await sql`SELECT id,payload_sha256,fetched_at,event_at,known_at,source_payload FROM provider_ingest_receipts ORDER BY id`.execute(database.db)).rows;
 await sql`UPDATE player_history_runs SET next_allowed_at=clock_timestamp()-interval '1 second'`.execute(database.db);
 const responses=await Promise.all([post(),post(),post()]);expect(responses.every(r=>r.statusCode===202)).toBe(true);const id=responses[0]!.json().run.id;
 expect(new Set(responses.map(r=>r.json().run.id)).size).toBe(1);expect(id).not.toBe(rootId);
 const provider=syntheticPlayerHistory({enrichment:true,onCall:p=>resumeCalls.push(p)});
 await executePlayerHistory(database.db,id,1,{...provider,discover:async()=>{throw Error('unexpected_discovery');},getHeroes:async()=>{throw Error('unexpected_heroes');},getLeagues:async()=>{throw Error('unexpected_leagues');},getMatchSource:async()=>{throw Error('unexpected_detail');}});
 await boss.cancel(PLAYER_HISTORY_QUEUE,id);
 const run=await repo.get(id);expect(run?.report).toMatchObject({operation:'evidence_resume',parentRunId:rootId,accepted:2,failed:0,excluded:0,enrichment:{accountsVerified:5,replayedMaps:2,unresolvedAccounts:[]}});
 const code=await readV1RuntimeCode(),at=new Date().toISOString();
 await expect(new V1DataRepository(database.db).exportReleaseInventory({fromAt:'2024-01-01T00:00:00.000Z',toAt:at,snapshotAt:at,maxMaps:5000},code.code)).rejects.toThrow('v1_synthetic_evidence_forbidden');
 expect(run?.report).toMatchObject({enrichment:{players:[],assessedAt:null,reasons:expect.arrayContaining(['HISTORY_READINESS_UNAVAILABLE'])}});
 expect(resumeCalls).toEqual(['/api/proPlayers']);expect(originalCalls.filter(p=>p.includes('/matches/'))).toHaveLength(2);
 expect((await repo.get(rootId))?.report).toEqual(old?.report);expect((await repo.get(rootId))?.source_audit).toEqual(old?.source_audit);
 const after=(await sql`SELECT id,payload_sha256,fetched_at,event_at,known_at,source_payload FROM provider_ingest_receipts ORDER BY id`.execute(database.db)).rows;
 expect(after.slice(0,originals.length)).toEqual(originals);
 expect((await sql`SELECT count(*)::int n FROM matches`.execute(database.db)).rows[0]).toEqual({n:2});
 expect((await sql`SELECT count(*)::int n FROM match_players WHERE player_id IS NOT NULL`.execute(database.db)).rows[0]).toEqual({n:20});
 expect((await sql`SELECT count(*)::int n FROM player_history_projection_replays`.execute(database.db)).rows[0]).toEqual({n:2});
 await expect(sql`UPDATE player_history_runs SET report='{}'::jsonb WHERE id=${rootId}::uuid`.execute(database.db)).rejects.toThrow('history_resume_report_immutable');
 await expect(sql`DELETE FROM player_history_runs WHERE id=${id}::uuid`.execute(database.db)).rejects.toThrow('history_resume_report_immutable');
 await expect(sql`UPDATE player_history_runs SET report='{}'::jsonb WHERE id=${id}::uuid`.execute(database.db)).rejects.toThrow('history_resume_report_immutable');
 await expect(sql`UPDATE player_history_projection_replays SET derived_sha256=${'0'.repeat(64)}`.execute(database.db)).rejects.toThrow('history_projection_immutable');
 await expect(sql`TRUNCATE player_history_projection_replays`.execute(database.db)).rejects.toThrow('history_projection_immutable');
});
it('repeating evidence checks is idempotent for facts, identities and series and never downloads maps',async()=>{
 const repo=new PlayerHistoryRepository(database.db),bindings=(await repo.bindings(ids))!;
 await sql`UPDATE player_history_runs SET next_allowed_at=clock_timestamp()-interval '1 second'`.execute(database.db);
 const latest=await repo.latest(owner,(await repo.get(rootId))!.lineup_key);const id=await enqueuePlayerHistoryResume(boss,database.db,owner,latest!.id);
 const before=(await sql`SELECT (SELECT count(*)::int FROM player_account_evidence) accounts,(SELECT count(*)::int FROM series) series,(SELECT sum(data_revision)::text FROM matches) revision`.execute(database.db)).rows[0];
 await executePlayerHistory(database.db,id,1,syntheticPlayerHistory({enrichment:true,onCall:p=>resumeCalls.push(p)}));await boss.cancel(PLAYER_HISTORY_QUEUE,id);
 expect((await repo.get(id))?.parent_run_id).toBe(rootId);expect(resumeCalls).toEqual(['/api/proPlayers']);
 expect((await sql`SELECT (SELECT count(*)::int FROM player_account_evidence) accounts,(SELECT count(*)::int FROM series) series,(SELECT sum(data_revision)::text FROM matches) revision`.execute(database.db)).rows[0]).toEqual(before);
 await expect(sql`INSERT INTO player_history_runs(id,owner_user_id,lineup_key,bindings,options,status,operation,parent_run_id,scope_map_ids)
  VALUES(${randomUUID()}::uuid,${owner}::uuid,${(await repo.get(rootId))!.lineup_key},${JSON.stringify(bindings)}::jsonb,${JSON.stringify((await repo.get(rootId))!.options)}::jsonb,'queued','evidence_resume',${rootId}::uuid,'["1"]'::jsonb)`.execute(database.db)).rejects.toThrow('history_resume_scope_invalid');
});
it('does not let cached private profiles starve untried accounts in subsequent bounded batches',async()=>{
 const accounts=Array.from({length:25},(_,i)=>String(6001+i));let requests=0;
 const client=new OpenDotaClient({attempts:1,maxRequests:30},{sleep:async()=>undefined,fetch:async()=>{requests++;return new Response(JSON.stringify({profile:null}));}});
 const provider={...syntheticPlayerHistory({enrichment:true}),getPlayer:(id:string)=>client.getPlayer(id)};
 const {enrichHistoryEvidence}=await import('@dota/ingestion'),repo=new PlayerHistoryResumeRepository(database.db);
 await enrichHistoryEvidence(database.db,provider,await repo.accountOrder(accounts),[],async()=>true);expect(requests).toBe(20);
 await enrichHistoryEvidence(database.db,provider,await repo.accountOrder(accounts),[],async()=>true);expect(requests).toBe(25);
});
it('reports unavailable stored provenance without silently re-downloading the old maps',async()=>{
 const repo=new PlayerHistoryRepository(database.db),root=(await repo.get(rootId))!,legacy=randomUUID();
 await sql`INSERT INTO player_history_runs(id,owner_user_id,lineup_key,bindings,options,status,report,source_audit,finished_at)
  VALUES(${legacy}::uuid,${owner}::uuid,${root.lineup_key},${JSON.stringify(root.bindings)}::jsonb,${JSON.stringify(root.options)}::jsonb,'completed',${JSON.stringify(root.report)}::jsonb,'{}'::jsonb,clock_timestamp())`.execute(database.db);
 await sql`UPDATE player_history_runs SET next_allowed_at=clock_timestamp()-interval '1 second'`.execute(database.db);
 const before=resumeCalls.length,id=await enqueuePlayerHistoryResume(boss,database.db,owner,legacy);
 await executePlayerHistory(database.db,id,1,syntheticPlayerHistory({enrichment:true,onCall:p=>resumeCalls.push(p)}));await boss.cancel(PLAYER_HISTORY_QUEUE,id);
 expect(resumeCalls).toHaveLength(before);expect((await repo.get(id))?.report).toMatchObject({accepted:0,excluded:2,maps:expect.arrayContaining([expect.objectContaining({reasons:['STORED_PROJECTION_UNAVAILABLE']})])});
});
it('allows retry of an abandoned resume without a report or repeating discovery',async()=>{
 const repo=new PlayerHistoryRepository(database.db);await sql`UPDATE player_history_runs SET next_allowed_at=clock_timestamp()-interval '1 second'`.execute(database.db);
 const id=await enqueuePlayerHistoryResume(boss,database.db,owner,rootId);await repo.abandoned(id);await boss.cancel(PLAYER_HISTORY_QUEUE,id);
 const state=await app.inject({url:'/api/v1/players/history-refresh?playerIds='+ids.join(','),headers:{cookie}});
 expect(state.statusCode).toBe(200);expect(state.json()).toMatchObject({canResume:true,run:{id,operation:'evidence_resume',report:null,errorCode:'worker_unavailable'}});
 await sql`UPDATE player_history_runs SET next_allowed_at=clock_timestamp()-interval '1 second'`.execute(database.db);
 const r=await post(id);expect(r.statusCode).toBe(202);expect(r.json().run.id).not.toBe(id);
 const next=r.json().run.id;await executePlayerHistory(database.db,next,1,syntheticPlayerHistory({enrichment:true,onCall:p=>resumeCalls.push(p)}));await boss.cancel(PLAYER_HISTORY_QUEUE,next);
 expect((await repo.get(next))?.report).toMatchObject({operation:'evidence_resume',accepted:2});
});
it('refuses resume after a selected numeric account becomes conflicting',async()=>{
 await new IdentityRepository(database.db).appendAccountEvidence({playerId:ids[0]!,externalAccountId:'1001',provider:'opendota',status:'rejected',eventAt:null,knownAt:null,fetchedAt:new Date().toISOString(),source:'synthetic',evidenceRef:'synthetic rejected after history'});
 await expect(enqueuePlayerHistoryResume(boss,database.db,owner,rootId)).rejects.toThrow('identity_changed');
 expect((await post()).statusCode).toBe(409);
});
