import {randomBytes,createHash} from 'node:crypto';
import {beforeAll,afterAll,expect,test} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {StrengthReportSchema,StrengthResponseSchema} from '@dota/contracts';
import {IdentityRepository,sql} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedStrength,addStrengthEvidence} from '../../../tests/helpers/strength.js';
import {catalogTeamId,catalogPlayerId} from '../../../tests/helpers/catalog.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string;
const route=`/api/v1/teams/${catalogTeamId}/strength`,base='cutoffAt=2024-01-03T00:00:00.000Z';
beforeAll(async()=>{
  database=await testDatabase();await seedStrength(database.db);
  const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-strength',password);
  app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-strength',password}});
  const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');
},30000);
afterAll(async()=>{await app?.close();await database?.close();},30000);
const get=(query=base,path=route)=>app.inject({url:path+'?'+query,headers:{cookie}});
test('owner-only no-store report compares raw organization results to prior opponent strength without probabilities',async()=>{
  expect((await app.inject(route)).statusCode).toBe(401);
  const response=await get();expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
  const r=StrengthReportSchema.parse(response.json());expect(r.summary).toMatchObject({nRaw:2,wins:1,winRate:0.5,ratedMaps:2,meanOpponentRatingBefore:1492});
  expect(r.maps[0]?.rating).toMatchObject({ownBefore:1516,opponentBefore:1484,lineupKnownBeforeStart:false});
  expect(r.teamAWinProbability).toBeNull();expect(r.policy.validation).toBe('unvalidated');expect(r.coverage.globalReplayMaps).toBe(2);
});
test('report window does not erase global warmup and canonical cached projection is ignored',async()=>{
  await sql`UPDATE match_players SET player_id=NULL WHERE match_id=8001`.execute(database.db);
  const r=StrengthReportSchema.parse((await get(base+'&fromAt=2024-01-02T00:00:00.000Z')).json());
  expect(r.summary.nRaw).toBe(1);expect(r.maps[0]?.rating?.ownBefore).toBe(1516);expect(r.replayManifest).toHaveLength(2);
  expect(StrengthReportSchema.parse((await get('fromAt=2025-01-01T00:00:00.000Z&cutoffAt=2025-02-01T00:00:00.000Z')).json()).summary.winRate).toBeNull();
});
test('new five under the same organization starts from new player histories rather than old tag results',async()=>{
  await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,radiant_team_id,dire_team_id)
    VALUES(8301,'2024-01-03T12:00:00Z',1800,true,true,${catalogTeamId},9007199254740994)`.execute(database.db);
  for(let i=0;i<10;i++)await sql`INSERT INTO match_players(match_id,player_slot,side,hero_id,source_account_id)
    VALUES(8301,${i<5?i:i+123},${i<5?'radiant':'dire'},1,${i<5?1010+i:1000+i})`.execute(database.db);
  await addStrengthEvidence(database.db,'8301');
  const r=StrengthReportSchema.parse((await get('cutoffAt=2024-01-04T00:00:00.000Z')).json());
  expect(r.maps[0]?.rating).toMatchObject({ownBefore:1500,priorPlayers:5});expect(r.maps[0]?.rating?.fingerprint).not.toBe(r.maps[1]?.rating?.fingerprint);
});
test('unknown outcome availability does not become usable from end time; delayed proof stays pending',async()=>{
  await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,radiant_team_id,dire_team_id)
    VALUES(8302,'2024-01-04T12:00:00Z',1800,true,true,${catalogTeamId},9007199254740994)`.execute(database.db);
  await sql`INSERT INTO match_players(match_id,player_slot,side,hero_id,source_account_id)
    SELECT 8302,player_slot,side,hero_id,source_account_id FROM match_players WHERE match_id=8001`.execute(database.db);
  const q='fromAt=2024-01-04T00:00:00.000Z&cutoffAt=2024-01-05T00:00:00.000Z';
  const missing=StrengthReportSchema.parse((await get(q)).json());expect(missing.summary).toMatchObject({nRaw:1,ratedMaps:0});expect(missing.maps[0]?.rating).toBeNull();
  await addStrengthEvidence(database.db,'8302','2025-01-01T00:00:00.000Z');
  const pending=StrengthReportSchema.parse((await get(q)).json());expect(pending.maps[0]?.rating).toMatchObject({updateApplied:false,change:null});
  expect(pending.coverage.pendingUpdates).toBe(1);
});
test('PostgreSQL microsecond completion cannot leak across cutoff, and exact-start target is excluded',async()=>{
  await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,radiant_team_id)
    VALUES(8303,'2024-01-02T11:30:00.000001Z',1800,true,true,${catalogTeamId})`.execute(database.db);
  const r=StrengthReportSchema.parse((await get('cutoffAt=2024-01-02T12:00:00.000Z')).json());
  expect(r.summary.nRaw).toBe(1);expect(r.maps.map(m=>m.matchId)).toEqual(['8001']);expect(r.coverage.unfinished).toBe(1);
  await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,radiant_team_id,dire_team_id)
    VALUES(8304,'2024-01-01T13:00:00Z',1800,true,true,${catalogTeamId},9007199254740994)`.execute(database.db);
  await sql`INSERT INTO match_players(match_id,player_slot,side,hero_id,source_account_id)
    SELECT 8304,player_slot,side,hero_id,source_account_id FROM match_players WHERE match_id=8001`.execute(database.db);
  await addStrengthEvidence(database.db,'8304','2024-01-02T12:00:00.000001Z');
  const micro=StrengthReportSchema.parse((await get('cutoffAt=2024-01-02T12:00:00.000Z')).json());
  expect(micro.maps.find(m=>m.matchId==='8304')?.rating).toMatchObject({updateApplied:false,change:null});
  expect(micro.coverage.pendingUpdates).toBe(1);
});
test('a later conflicting result stops replay at its historical availability without rewriting old strengths',async()=>{
  const digest=createHash('sha256').update('false').digest('hex');
  await sql`INSERT INTO match_field_observations(match_id,field_name,provider,value,event_at,known_at,fetched_at,evidence_ref,adapter_version,value_sha256,
    review_state,availability_class,earliest_stage) VALUES(8001,'radiant_win','synthetic','false'::jsonb,'2024-01-01T12:30:00Z','2025-01-01T00:00:00Z',
    '2026-10-31T00:00:00Z','synthetic:later-conflict','synthetic-v1',${digest},'accepted','verified_asof','post_match')`.execute(database.db);
  const r=StrengthReportSchema.parse((await get('fromAt=2023-01-01T00:00:00.000Z&cutoffAt=2026-01-01T00:00:00.000Z')).json());
  expect(r.replayStoppedAtUs).toBe(String(BigInt(Date.parse('2025-01-01T00:00:00Z'))*1000n));
  expect(r.maps.find(m=>m.matchId==='8002')?.rating?.ownBefore).toBe(1516);expect(r.summary.lastObservedFiveRating).toBeNull();
});
test('future identity conflict cannot alter past snapshots; an actual historic conflict fails closed',async()=>{
  const identity=new IdentityRepository(database.db),input={playerId:String(BigInt(catalogPlayerId)+1n),externalAccountId:'1000',provider:'opendota' as const,status:'verified' as const,
    eventAt:null,fetchedAt:'2026-10-31T00:00:00.000Z',evidenceRef:'synthetic:conflict',source:'synthetic'};
  await identity.appendAccountEvidence({...input,knownAt:'2025-01-01T00:00:00.000Z'});
  expect(StrengthReportSchema.parse((await get()).json()).summary.ratedMaps).toBe(3);
  await identity.appendAccountEvidence({...input,knownAt:'2023-01-01T00:00:00.000Z'});
  const r=StrengthReportSchema.parse((await get()).json());expect(r.summary.ratedMaps).toBe(0);expect(r.coverage.identityUnavailable).toBeGreaterThan(0);
});
test('invalid query and missing organization return structured errors; large global history is never target-only truncated',async()=>{
  for(const query of ['limit=1','cutoffAt=2999-01-01T00:00:00.000Z','fromAt=2999-01-01T00:00:00.000Z','heroId=1'])expect((await get(query)).statusCode).toBe(400);
  expect((await get(base,'/api/v1/teams/1e3/strength')).statusCode).toBe(400);expect((await get(base,'/api/v1/teams/99999/strength')).statusCode).toBe(404);
  await sql`INSERT INTO matches(id,started_at,is_pro) SELECT 100000+n,'2023-01-01'::timestamptz,NULL FROM generate_series(1,5001) n`.execute(database.db);
  expect(StrengthResponseSchema.parse((await get()).json())).toMatchObject({status:'unavailable',reason:'GLOBAL_HISTORY_TOO_LARGE'});
});
