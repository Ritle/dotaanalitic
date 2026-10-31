import {randomBytes} from 'node:crypto';
import {beforeAll,afterAll,expect,test} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {PlayerHeroReportSchema,ProMapReportSchema} from '@dota/contracts';
import {sql,MatchContextRepository} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedSamples,assignSampleSeries} from '../../../tests/helpers/sample.js';
import {catalogPlayerId,catalogTeamId} from '../../../tests/helpers/catalog.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,cookie:string;
const route=`/api/v1/players/${catalogPlayerId}/heroes`,query='fromAt=2024-01-01T00:00:00.000Z&cutoffAt=2024-01-03T00:00:00.000Z&heroId=1';
beforeAll(async()=>{
  database=await testDatabase();await seedSamples(database.db);
  const password=randomBytes(24).toString('base64url');await new AuthService(database.db).provision('synthetic-samples',password);
  app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-samples',password}});
  const cookies=login.headers['set-cookie'];cookie=(Array.isArray(cookies)?cookies:[cookies??'']).map(c=>c.split(';')[0]).join('; ');
},30000);
afterAll(async()=>{await app?.close();await database?.close();},30000);
const get=(q=query)=>app.inject({url:route+'?'+q,headers:{cookie}});
test('sample categories and prior remain owner-only/no-store; raw counts and field denominators are unchanged',async()=>{
  expect((await app.inject(route)).statusCode).toBe(401);
  const response=await get();expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
  const r=PlayerHeroReportSchema.parse(response.json());expect(r.summary).toMatchObject({nRaw:2,wins:1,winRate:0.5,kda:{nMaps:1},sampleEvidence:{band:'under_10',nEff:null,weightPolicyVersion:null}});
  expect(r.referencePool.coverage.eligibleMaps).toBe(5);expect(r.referencePool.provenance.every(m=>m.startedAt<r.fromAt)).toBe(true);
  expect(r.smoothing.status).toBe('unavailable');expect(r.model).toBeNull();
});
test('comparable earlier hero-role-patch counts fit empirical prior without target-window tuning',async()=>{
  const r=PlayerHeroReportSchema.parse((await get(query+'&rolePos=1')).json());
  expect(r.summary).toMatchObject({nRaw:1,wins:1,winRate:1});expect(r.smoothing).toMatchObject({status:'available',smoothedObservedRate:0.5,priorOnly:false,
    prior:{alpha:1,beta:2,mass:3,mean:1/3,heroId:'1',rolePos:1,patchId:'1'}});
  expect(r.smoothing.prior?.matchIds).toEqual(['9001','9002','9003']);expect(r.smoothing.prior?.matchIds).not.toContain('8001');
  const second=PlayerHeroReportSchema.parse((await get(query+'&rolePos=2')).json());expect(second.smoothing.smoothedObservedRate).toBeCloseTo(1/3);
  expect(second.summary.winRate).toBe(0);
});
test('per-role estimates stay separate and global/pro-patch reference counters use the same unique-map denominator',async()=>{
  const r=PlayerHeroReportSchema.parse((await get()).json());expect(r.groups.map(g=>g.rolePos)).toEqual([1,2]);
  expect(r.groups[0]?.smoothing.prior?.mass).toBe(3);expect(r.groups[1]?.smoothing.prior?.mass).toBe(2);
  const global=r.referencePool.globalBuckets.find(b=>b.heroId==='1'&&b.rolePos===1),patch=r.referencePool.buckets.find(b=>b.heroId==='1'&&b.rolePos===1&&b.patchId==='1');
  expect(global).toMatchObject({nRaw:3,wins:1,winRate:1/3});expect(patch?.nRaw).toBe(global?.nRaw);
});
test('zero observed sample keeps raw rate null while a labeled prior-only estimate is permitted',async()=>{
  const r=PlayerHeroReportSchema.parse((await get('fromAt=2024-01-03T00:00:00.000Z&cutoffAt=2024-01-04T00:00:00.000Z&heroId=1&rolePos=1')).json());
  expect(r.summary).toMatchObject({nRaw:0,winRate:null,sampleEvidence:{band:'empty',coldStart:true}});
  expect(r.smoothing).toMatchObject({status:'available',priorOnly:true,smoothedObservedRate:0.5});expect(r.smoothing.prior?.mass).toBe(4);
});
test('known target series and a future completion microsecond cannot leak into the reference prior',async()=>{
  await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,radiant_team_id,dire_team_id)
    VALUES(9050,'2023-05-01T12:00:00Z',1800,true,true,${catalogTeamId},9007199254740994),
    (9051,'2023-12-31T23:30:00.000001Z',1800,true,true,${catalogTeamId},9007199254740994)`.execute(database.db);
  await sql`INSERT INTO match_players(match_id,player_slot,side,hero_id,source_account_id)
    SELECT 9050,player_slot,side,hero_id,source_account_id FROM match_players WHERE match_id=8001`.execute(database.db);
  await new MatchContextRepository(database.db).append({matchId:'9050',fact:{field:'roles',value:Array.from({length:5},(_,i)=>({playerSlot:i,playerId:String(BigInt(catalogPlayerId)+BigInt(i)),rolePos:i+1,basis:'confirmed',confidence:1}))},
    eventAt:null,knownAt:null,fetchedAt:'2026-10-31T00:00:00.000Z',provider:'synthetic',providerRecordId:null,evidenceRef:'synthetic:reference-roles',adapterVersion:'synthetic-v1',reviewState:'accepted',availability:'retrospective_fact',earliestStage:'post_match'});
  await assignSampleSeries(database.db,'9050','00000000-0000-4000-8000-000000008001');
  const r=PlayerHeroReportSchema.parse((await get(query+'&rolePos=1')).json());expect(r.smoothing.prior?.mass).toBe(3);
  expect(r.smoothing.prior?.matchIds).not.toContain('9050');expect(r.referencePool.provenance.some(m=>m.matchId==='9051')).toBe(false);
});
test('unknown target series disables smoothing without removing an otherwise valid observed map',async()=>{
  await sql`UPDATE matches SET series_id=NULL WHERE id=8001`.execute(database.db);
  const r=PlayerHeroReportSchema.parse((await get(query+'&rolePos=1')).json());expect(r.summary).toMatchObject({nRaw:1,winRate:1});
  expect(r.smoothing).toMatchObject({status:'unavailable',smoothedObservedRate:null,reasons:['TARGET_SERIES_UNVERIFIED']});
  const pro=ProMapReportSchema.parse((await app.inject({url:`/api/v1/teams/${catalogTeamId}/matches?fromAt=2024-01-01T00:00:00.000Z&cutoffAt=2024-01-03T00:00:00.000Z`,headers:{cookie}})).json());
  expect(pro.summary.sampleEvidence).toMatchObject({nRaw:2,band:'under_10',nEff:null});
});
test('reference overflow cannot truncate into a plausible prior or block raw player statistics',async()=>{
  await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro)
    SELECT 100000+n,'2023-01-01'::timestamptz,1800,true,true FROM generate_series(1,5001) n`.execute(database.db);
  const r=PlayerHeroReportSchema.parse((await get(query+'&rolePos=1')).json());expect(r.summary).toMatchObject({nRaw:1,winRate:1});
  expect(r.referencePool).toMatchObject({status:'unavailable',reason:'GLOBAL_REFERENCE_TOO_LARGE'});
  expect(r.referencePool.coverage.candidates).toBeNull();
  expect(r.smoothing.smoothedObservedRate).toBeNull();expect(r.smoothing.prior).toBeNull();
});
