import {test,expect,beforeEach,afterEach} from 'vitest';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {sql} from '@dota/db';
import {testDatabase} from '../../../tests/helpers/postgres';
import {seedPredictionScenario} from '../../../tests/helpers/predictions';
import {syntheticTargetMatch} from '../../../tests/helpers/schedule-target';
import {runtimeFixture} from '../../../packages/db/tests/v1-runtime-fixtures';
import {AuthService} from '../src/modules/auth/service';
import {LiveEstimateService} from '../src/modules/live/estimate-service';
import {LiveScheduleRepository} from '../src/modules/live/repository';
import {LiveScheduleService} from '../src/modules/live/service';
import {LiveSnapshotSchema,LIVE_ENDPOINT} from '../src/modules/live/contract';
import {UpcomingService} from '../src/modules/upcoming/service';
import {RosterCatalogueService} from '../src/modules/upcoming/catalogue-service';
import {buildApp} from '../src/app';
import {readConfig} from '../src/config';
let database:Awaited<ReturnType<typeof testDatabase>>,owner:string,password:string,base:Awaited<ReturnType<typeof seedPredictionScenario>>,service:LiveEstimateService;
const matchId='9007199254740993';
const scope=()=>({...runtimeFixture().request.targetScope!,fromAt:'2026-01-01T00:00:00.000Z',until:'2027-01-01T00:00:00.000Z'});
const request=()=>({requestId:randomUUID(),acknowledgedConditional:true as const,providerTeamAId:'74',providerTeamBId:'75',teamAId:'11',teamBId:'22',lineupA:base.lineupA,lineupB:base.lineupB,tournament:{leagueId:'77',scope:scope()}});
beforeEach(async()=>{
 database=await testDatabase();base=await seedPredictionScenario(database.db);password=randomBytes(24).toString('hex');owner=(await new AuthService(database.db).provision('synthetic-live-estimate',password)).id;
 const repo=new LiveScheduleRepository(database.db),lease=await repo.claim();await repo.publish(lease!,LiveSnapshotSchema.parse({data:[{...syntheticTargetMatch({providerMatchId:matchId,scheduledAt:new Date(Date.now()-3600000).toISOString()}),status:'running',beganAt:null,seriesScore:null}],
  source:{provider:'pandascore',adapterVersion:'pandascore-running-v1',endpoint:LIVE_ENDPOINT,fetchedAt:new Date().toISOString(),knownAt:null,payloadSha256:'a'.repeat(64),attempts:1,rateLimitRemaining:null}}));
 service=new LiveEstimateService(database.db,new LiveScheduleService(database.db));
},30000);
afterEach(async()=>{await database?.close();},30000);
test('past-running series produces immutable unavailable estimate without active model; retry and owner isolation',async()=>{
 const req=request(),a=await service.run(owner,matchId,req);expect(a.status).toBe('unavailable');expect(a.teamAWinProbability).toBeNull();expect(a.reasons.length).toBeGreaterThan(0);
 expect(a.scenario.input.scheduledAt).toBeNull();expect(a.scenario.recordedAt<=a.cutoffAt).toBe(true);
 expect(a.reasons).not.toContain('TARGET_ALREADY_STARTED');expect(await service.run(owner,matchId,req)).toEqual(a);
 await expect(service.run(owner,matchId,{...req,teamAId:'22',teamBId:'11'})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
 expect((await service.history(owner,matchId)).items).toEqual([a]);expect((await service.history(randomUUID(),matchId)).items).toEqual([]);
 const rows=(await sql<{snapshot_text:string;snapshot_sha256:string}>`SELECT snapshot_text,snapshot_sha256 FROM live_lineup_estimates`.execute(database.db)).rows;
 expect(rows).toHaveLength(1);expect(createHash('sha256').update(rows[0]!.snapshot_text).digest('hex')).toBe(rows[0]!.snapshot_sha256);
 await expect(sql`DELETE FROM live_lineup_estimates`.execute(database.db)).rejects.toThrow('live_lineup_estimate_immutable');
 for(const table of ['scenarios','prediction_runs','v1_runtime_snapshots','v1_schedule_targets','prediction_outcomes'])expect((await sql<{n:number}>`SELECT count(*)::int n FROM ${sql.table(table)}`.execute(database.db)).rows[0]!.n).toBe(0);
},30000);
test('stale source, changed sides, unknown references and wrong scope fail before storage',async()=>{
 await expect(service.run(owner,matchId,{...request(),providerTeamAId:'75',providerTeamBId:'74'})).rejects.toMatchObject({code:'PARTICIPANTS_CHANGED'});
 const r=request();r.lineupA=r.lineupA.map((p,i)=>i===0?{...p,playerId:'999'}:p);await expect(service.run(owner,matchId,r)).rejects.toMatchObject({code:'VALIDATION_ERROR'});
 const wrong=request();wrong.tournament.scope.leagueId='999';await expect(service.run(owner,matchId,wrong)).rejects.toMatchObject({code:'TOURNAMENT_REQUIRED'});
 await sql`UPDATE live_schedule_cache SET expires_at=clock_timestamp()-interval '1 second'`.execute(database.db);
 await expect(service.run(owner,matchId,request())).rejects.toMatchObject({code:'LIVE_SOURCE_STALE'});
 expect((await service.history(owner,matchId)).items).toHaveLength(0);
});
test('running roster lookup uses fresh live cache without contaminating future schedule',async()=>{
 const upcoming=new UpcomingService(database.db,undefined,undefined,new LiveScheduleService(database.db));
 expect((await upcoming.schedule()).snapshot).toBeNull();expect((await upcoming.findMatch(matchId))?.status).toBe('running');
 const catalogue=new RosterCatalogueService(database.db,upcoming,async()=>{throw Error('Unexpected provider');});
 expect((await catalogue.state(owner,matchId)).teams).toHaveLength(2);
 await sql`UPDATE live_schedule_cache SET expires_at=clock_timestamp()-interval '1 second'`.execute(database.db);
 await expect(catalogue.state(owner,matchId)).rejects.toThrow();
});
test('estimate HTTP requires session, CSRF, origin and owner; history remains private',async()=>{
 const app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
 try{
  const url=`/api/v1/live/${matchId}/estimates`;expect((await app.inject({url})).statusCode).toBe(401);
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-live-estimate',password}});
  const cookie=login.cookies.map(c=>c.name+'='+c.value).join('; '),csrf=login.json().csrfToken;
  expect((await app.inject({method:'POST',url,headers:{cookie,origin:'http://localhost:5173'},payload:request()})).statusCode).toBe(403);
  const headers={cookie,origin:'http://localhost:5173','x-csrf-token':csrf};
  expect((await app.inject({method:'POST',url,headers,payload:{...request(),acknowledgedConditional:false}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url,headers,payload:request()})).statusCode).toBe(200);
  await sql`UPDATE app_users SET account_role='user' WHERE id=${owner}::uuid`.execute(database.db);
  expect((await app.inject({method:'POST',url,headers,payload:request()})).statusCode).toBe(403);
  expect((await app.inject({url,headers:{cookie}})).statusCode).toBe(200);
 }finally{await app.close();}
},30000);

test('live estimate accepts an unclassified event without inventing tier or local league',async()=>{
 const {tournament,...body}=request();const result=await service.run(owner,matchId,body);
 expect(result.scenario.input.context.leagueId).toBeNull();
 expect(result.reasons).toContain('NO_ACTIVE_MODEL');
 const row=(await sql<{scope:unknown}>`SELECT snapshot_text::jsonb->'scope' scope FROM live_lineup_estimates`.execute(database.db)).rows[0]!;
 expect(row.scope).toBeNull();
});
