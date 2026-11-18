import {randomBytes,randomUUID} from 'node:crypto';
import {beforeAll,afterAll,test,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {DraftCaptureSavedSchema} from '../src/modules/scenarios/draft-capture-contract.js';
import {DraftCaptureRepository} from '../src/modules/scenarios/draft-capture-repository.js';
import {sql,ScenarioRepository,V1ScheduleTargetRepository} from '@dota/db';
import {captureHistory} from '../src/modules/scenarios/draft-capture-source.js';
import {captureIdentities} from '../src/modules/scenarios/draft-capture-source.js';
import {registryHash} from '../../../packages/db/src/v1-registry.js';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedStrength} from '../../../tests/helpers/strength.js';
import {scenarioInput} from '../../../tests/helpers/scenario.js';
import {publishTargetSchedule,syntheticTargetMatch} from '../../../tests/helpers/schedule-target.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,owner:string,cookie:string,csrf:string,series:string;
beforeAll(async()=>{
  database=await testDatabase();await seedStrength(database.db);
  for(let i=2;i<=10;i++)await sql`INSERT INTO heroes(id,internal_name,localized_name) VALUES(${i},${'synthetic_'+i},${'Synthetic '+i})`.execute(database.db);
  series=randomUUID();const s=scenarioInput();
  await sql`INSERT INTO series(id,team_a_id,team_b_id,best_of,provider,provider_series_id)
    VALUES(${series}::uuid,${s.teamAId},${s.teamBId},3,'opendota','123456')`.execute(database.db);
  await sql`INSERT INTO provider_ingest_receipts(provider,provider_match_id,canonical_match_id,adapter_version,normalizer_version,
    context_sha256,payload_sha256,fetched_at,source_payload,status,reasons)
    VALUES('opendota','8001',8001,'synthetic-v1','synthetic-v1',${'a'.repeat(64)},${'b'.repeat(64)},
      '2026-10-31','{"match_id":8001,"players":[]}'::jsonb,'accepted','[]'::jsonb)`.execute(database.db);
  const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-capture',password);
  app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-capture',password}});
  const c=login.headers['set-cookie'];cookie=(Array.isArray(c)?c:[c??'']).map(v=>v.split(';')[0]).join('; ');csrf=login.json().csrfToken;owner=login.json().owner.id;
},30000);
afterAll(async()=>{await app?.close();await database?.close();},30000);
function input(){const s=scenarioInput();s.context={...s.context,seriesId:series,mapNumber:1};
  s.draft={assignments:(['A','B'] as const).flatMap((teamSlot,j)=>Array.from({length:5},(_,i)=>({teamSlot,rolePos:i+1,heroId:5*j+i+1}))),bans:[]};return s;}
const save=()=>new ScenarioRepository(database.db).save(owner,input());
const post=(id:string,payload:unknown={expectedRevision:1})=>app.inject({method:'POST',url:`/api/v1/scenarios/${id}/draft-captures`,
  headers:{cookie,origin:'http://localhost:5173','x-csrf-token':csrf},payload});

test('history summary reads only linked evidence, keeps counts separate from features and never writes',async()=>{
  const s=await save();await post(s.id);const url=`/api/v1/scenarios/${s.id}/draft-captures/1/history-summary`;
  const before=(await sql`SELECT evidence_sha256 FROM owner_draft_history_observations ORDER BY id`.execute(database.db)).rows;
  const r=await app.inject({method:'GET',url,headers:{cookie}});expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({status:'saved',maps:2,forecastStatus:'unavailable'});
  expect(r.json().verifiedMaps+r.json().excludedMaps).toBe(2);
  expect(r.json()).not.toHaveProperty('players');expect(r.headers['cache-control']).toBe('no-store');
  expect((await sql`SELECT evidence_sha256 FROM owner_draft_history_observations ORDER BY id`.execute(database.db)).rows).toEqual(before);
  expect((await sql`SELECT id FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
  expect((await app.inject({method:'GET',url})).statusCode).toBe(401);
  const {readDraftHistorySummary}=await import('../src/modules/scenarios/draft-history-summary.js');
  await expect(readDraftHistorySummary(database.db,randomUUID(),s.id,1)).rejects.toMatchObject({code:'NOT_FOUND'});
  await sql`UPDATE app_users SET account_role='user' WHERE id=${owner}::uuid`.execute(database.db);
  try{expect((await app.inject({method:'GET',url,headers:{cookie}})).statusCode).toBe(403);}
  finally{await sql`UPDATE app_users SET account_role='owner' WHERE id=${owner}::uuid`.execute(database.db);}
});

test('owner-only, CSRF-protected, strict request; cross-owner read and capture do not disclose input',async()=>{
  const s=await save(),url=`/api/v1/scenarios/${s.id}/draft-captures`;
  expect((await app.inject({method:'POST',url,payload:{expectedRevision:1}})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url,headers:{cookie,origin:'http://localhost:5173'},payload:{expectedRevision:1}})).statusCode).toBe(403);
  expect((await post(s.id,{expectedRevision:1,decisionCutoffAt:'2020-01-01'})).statusCode).toBe(400);
  const repo=new DraftCaptureRepository(database.db),other=randomUUID();
  expect(await repo.get(other,s.id,1)).toBeNull();await expect(repo.create(other,s.id,{expectedRevision:1})).rejects.toMatchObject({code:'NOT_FOUND'});
  await sql`UPDATE app_users SET account_role='user' WHERE id=${owner}::uuid`.execute(database.db);
  try{
    expect((await post(s.id)).statusCode).toBe(403);
    expect((await app.inject({method:'GET',url:url+'/1',headers:{cookie}})).statusCode).toBe(403);
  }finally{await sql`UPDATE app_users SET account_role='owner' WHERE id=${owner}::uuid`.execute(database.db);}
});
test('freezes full draft, exact server clocks, available identities/history, typed pending map; no prediction',async()=>{
  const s=await save(),r=await post(s.id);expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('no-store');
  const saved=DraftCaptureSavedSchema.parse(r.json()),c=saved.snapshot;
  expect(c.status).toBe('captured');expect(c.players.map(p=>p.accountId)).toEqual(Array.from({length:10},(_,i)=>String(1000+i)));
  expect(c.players.map(p=>p.heroId)).toEqual([1,2,3,4,5,6,7,8,9,10]);
  expect(c.decisionCutoffAt).toMatch(/\.\d{6}Z$/);expect(saved.recordedAt>=c.decisionCutoffAt).toBe(true);
  expect(c.decisionCutoffAt).not.toBe(c.scenario.cutoffAt);expect(c.target).toMatchObject({status:'pending',providerSeriesId:'123456',mapNumber:1,actualMatchId:null});
  expect(c.history.maps.map(m=>m.id)).toEqual(['8001','8002']);expect(c.history.receipts).toHaveLength(1);
  expect(c.history.facts.length).toBeGreaterThan(0);expect(c.primaryEligible).toBe(false);
  const {sha256:_hash,status:_status,...body}=c.history;expect(registryHash(body)).toBe(c.history.sha256);
  expect((await app.inject({method:'GET',url:`/api/v1/scenarios/${s.id}/draft-captures/1`,headers:{cookie}})).json()).toEqual(saved);
  expect((await sql`SELECT 1 FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
});
test('concurrent identical requests persist one snapshot; retry survives newer revision, stale first capture conflicts',async()=>{
  const s=await save(),responses=await Promise.all([post(s.id),post(s.id)]);
  expect(responses.map(r=>r.statusCode)).toEqual([200,200]);expect(responses[1]!.json()).toEqual(responses[0]!.json());
  await new ScenarioRepository(database.db).save(owner,input(),{id:s.id,expectedRevision:1});
  expect((await post(s.id)).json()).toEqual(responses[0]!.json());
  const fresh=await save();await new ScenarioRepository(database.db).save(owner,input(),{id:fresh.id,expectedRevision:1});
  expect((await post(fresh.id)).statusCode).toBe(409);
});
test('partial draft and absent target persist diagnostics; later edits cannot repair previous capture',async()=>{
  const q=input();q.draft!.assignments.pop();q.context.seriesId=null;
  const s=await new ScenarioRepository(database.db).save(owner,q),r=await post(s.id),saved=r.json();
  expect(r.statusCode).toBe(200);expect(saved.snapshot.status).toBe('unavailable');
  expect(saved.snapshot.reasons).toContain('TEN_DISTINCT_HEROES_REQUIRED');expect(saved.snapshot.reasons).toContain('DRAFT_MAP_REFERENCE_MISSING');
  await new ScenarioRepository(database.db).save(owner,input(),{id:s.id,expectedRevision:1});expect((await post(s.id)).json()).toEqual(saved);
  expect((await post(s.id,{expectedRevision:2})).json().snapshot.status).toBe('captured');
});
test('foreign or missing schedule reference is recorded as unavailable instead of leaking target',async()=>{
  const q=input();const s=await new ScenarioRepository(database.db).save(owner,q);
  const r=await post(s.id,{expectedRevision:1,scheduleTargetRequestId:randomUUID()});expect(r.statusCode).toBe(200);expect(r.json().snapshot.target).toBeNull();
  expect(r.json().snapshot.reasons).toContain('DRAFT_TARGET_MISMATCH');
});
test('DB rejects mutation, deletion, hash tampering and promotion into a prediction',async()=>{
  const s=await save(),r=DraftCaptureSavedSchema.parse((await post(s.id)).json());
  await expect(sql`UPDATE owner_draft_captures SET snapshot_text='{}' WHERE id=${r.id}::uuid`.execute(database.db)).rejects.toThrow('immutable');
  await expect(sql`DELETE FROM owner_draft_captures WHERE id=${r.id}::uuid`.execute(database.db)).rejects.toThrow('immutable');
  const text=JSON.stringify({...r.snapshot,deployable:true});
  await expect(sql`INSERT INTO owner_draft_captures(id,owner_user_id,scenario_id,revision,snapshot_text,snapshot_sha256,decision_cutoff_at)
    VALUES(${randomUUID()}::uuid,${owner}::uuid,${s.id}::uuid,1,${text},${'0'.repeat(64)},clock_timestamp())`.execute(database.db)).rejects.toThrow('draft_capture_invalid');
});
test('strict history cutoff excludes start/sync/receipt equality and never substitutes public or unknown pro maps',async()=>{
  await sql`INSERT INTO matches(id,started_at,synced_at,is_pro) VALUES
    (9001,'2020-01-01','2020-01-01',true),(9002,'2021-01-01','2020-01-01',true),
    (9003,'2020-01-01','2021-01-01',true),(9004,'2020-01-01','2020-01-01',false),
    (9005,'2020-01-01','2020-01-01',NULL)`.execute(database.db);
  await sql`INSERT INTO provider_ingest_receipts(provider,provider_match_id,canonical_match_id,adapter_version,normalizer_version,
    context_sha256,payload_sha256,fetched_at,source_payload,status,reasons)
    VALUES('opendota','9001',9001,'synthetic','synthetic',${'c'.repeat(64)},${'d'.repeat(64)},'2021-01-01','{}','accepted','[]')`.execute(database.db);
  const h=await database.db.transaction().setIsolationLevel('repeatable read').execute(tx=>captureHistory(tx,'2021-01-01T00:00:00.000000Z'));
  expect(h.maps.map(m=>m.id)).toEqual(['9001']);expect(h.receipts).toEqual([]);expect(h.status).toBe('unavailable');
  const identities=await captureIdentities(database.db,['1000'],'2026-10-31T00:00:00.000000Z');
  expect(identities).toEqual([]);
});
test('saved schedule appointment supplies a pending second map, preserving bigint series ID and team orientation',async()=>{
  const match=syntheticTargetMatch(),source=await publishTargetSchedule(database.db,[match]),q=input();
  const target=await new V1ScheduleTargetRepository(database.db).create(owner,{requestId:randomUUID(),providerMatchId:match.providerMatchId,
    observationId:source.id,observationSha256:source.sha,expectedRevision:0,mapNumber:1,providerTeamAId:'74',providerTeamBId:'75',
    teamAId:q.teamAId,teamBId:q.teamBId,leagueId:null,reviewSourceUrl:'https://example.test/synthetic',reason:'Synthetic owner reviewed schedule association'});
  q.context.seriesId=null;q.context.mapNumber=2;
  const s=await new ScenarioRepository(database.db).save(owner,q),r=await post(s.id,{expectedRevision:1,scheduleTargetRequestId:target.record.request.requestId});
  expect(r.statusCode).toBe(200);expect(r.json().snapshot.target).toMatchObject({provider:'pandascore',providerSeriesId:match.providerMatchId,mapNumber:2,actualMatchId:null});
  expect(r.json().snapshot.target.evidence).toEqual(target);
  expect((await post(s.id)).json()).toEqual(r.json());
  expect((await post(s.id,{expectedRevision:1,scheduleTargetRequestId:randomUUID()})).statusCode).toBe(409);
  const swapped={...q,teamAId:q.teamBId,teamBId:q.teamAId};
  const wrong=await new ScenarioRepository(database.db).save(owner,swapped);
  expect((await post(wrong.id,{expectedRevision:1,scheduleTargetRequestId:target.record.request.requestId})).json().snapshot.reasons).toContain('DRAFT_TARGET_MISMATCH');
});
test('later identity conflict changes a new revision but never rewrites the saved account binding',async()=>{
  const s=await save(),r=await post(s.id),original=r.json();expect(original.snapshot.players[0].accountId).toBe('1000');
  await sql`INSERT INTO player_account_evidence(player_id,provider,external_account_id,link_status,source,evidence_ref,fetched_at,evidence_sha256)
    VALUES(${input().lineupA[1]!.playerId}::bigint,'stratz','1000','verified','synthetic','synthetic:conflict',
      date_trunc('milliseconds',clock_timestamp()),${'e'.repeat(64)})`.execute(database.db);
  expect((await post(s.id)).json()).toEqual(original);
  await new ScenarioRepository(database.db).save(owner,input(),{id:s.id,expectedRevision:1});
  const changed=(await post(s.id,{expectedRevision:2})).json();
  expect(changed.snapshot.status).toBe('unavailable');expect(changed.snapshot.players[0].accountId).toBeNull();
  expect(changed.snapshot.reasons).toContain('PLAYER_ACCOUNT_UNRESOLVED');
});
test('history ceiling persists an explicit refusal without publishing a truncated successful sample',async()=>{
  await sql`INSERT INTO matches(id,started_at,synced_at,is_pro)
    SELECT n,'2020-01-01'::timestamptz,'2020-01-01'::timestamptz,true FROM generate_series(100000,105000) n`.execute(database.db);
  const s=await save(),r=await post(s.id);expect(r.statusCode).toBe(200);
  expect(r.json().snapshot.status).toBe('unavailable');expect(r.json().snapshot.reasons).toContain('DRAFT_CAPTURE_HISTORY_LIMIT');
  expect(r.json().snapshot.history.maps).toEqual([]);expect(r.json().snapshot.history.status).toBe('unavailable');
  const summary=await app.inject({method:'GET',url:`/api/v1/scenarios/${s.id}/draft-captures/1/history-summary`,headers:{cookie}});
  expect(summary.json()).toMatchObject({status:'unavailable',maps:null,verifiedMaps:null,excludedMaps:null,reasons:['DRAFT_CAPTURE_HISTORY_LIMIT']});
});
