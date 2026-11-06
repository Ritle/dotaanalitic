import {randomBytes,randomUUID} from 'node:crypto';
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {ScenarioRepository,V1ScheduleTargetRepository,V1PredictionService,V1DataRepository,sql} from '@dota/db';
import {scheduleFreshnessReason} from '@dota/contracts';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedPredictionScenario} from '../../../tests/helpers/predictions.js';
import {publishTargetSchedule,syntheticTargetMatch} from '../../../tests/helpers/schedule-target.js';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {AuthService} from '../src/modules/auth/service.js';
let database:Awaited<ReturnType<typeof testDatabase>>,app:FastifyInstance,owner:string,cookie:string,csrf:string,scenarioId:string;
let match:ReturnType<typeof syntheticTargetMatch>,source:Awaited<ReturnType<typeof publishTargetSchedule>>;
const headers=()=>({cookie,origin:'http://localhost:5173','x-csrf-token':csrf});
const get=()=>app.inject({url:`/api/v1/upcoming/${match.providerMatchId}/target-preview`,headers:headers()});
const request=()=>({requestId:randomUUID(),providerMatchId:match.providerMatchId,observationId:source.id,observationSha256:source.sha,
  expectedRevision:0,mapNumber:1,providerTeamAId:'74',providerTeamBId:'75',teamAId:'11',teamBId:'22',leagueId:'77',
  reviewSourceUrl:'https://example.test/synthetic-freshness',reason:'Synthetic reviewed schedule freshness fixture'});
const post=(payload:unknown)=>app.inject({method:'POST',url:'/api/v1/schedule-targets',headers:headers(),payload});
beforeEach(async()=>{
  database=await testDatabase();const input=await seedPredictionScenario(database.db),password=randomBytes(24).toString('base64url');
  owner=(await new AuthService(database.db).provision('synthetic-freshness',password)).id;
  scenarioId=(await new ScenarioRepository(database.db).save(owner,{...input,context:{...input.context,mapNumber:1}})).id;
  match=syntheticTargetMatch({scheduledAt:input.scheduledAt});source=await publishTargetSchedule(database.db,[match]);
  app=await buildApp(readConfig({DATABASE_URL:database.url}),{db:database.db,logger:false});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:5173'},payload:{login:'synthetic-freshness',password}});
  const c=login.headers['set-cookie'];cookie=(Array.isArray(c)?c:[c??'']).map(x=>x.split(';')[0]).join('; ');csrf=login.json().csrfToken;
},30000);
afterEach(async()=>{vi.restoreAllMocks();await app?.close();await database?.close();},30000);
test('a newly recorded old source is ineligible; a later omitted page cannot renew its age',async()=>{
  source=await publishTargetSchedule(database.db,[match],new Date(Date.now()-16_200_000).toISOString());
  await publishTargetSchedule(database.db,[]);
  const response=await get();expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({eligible:false,reasons:['SCHEDULE_SOURCE_STALE'],omittingLaterPages:1});
  const saved=await post(request());expect(saved.statusCode).toBe(409);expect(saved.json().error.code).toBe('schedule_source_stale');
  expect((await sql`SELECT 1 FROM v1_schedule_targets`.execute(database.db)).rows).toHaveLength(0);
});
test('future source clocks are ineligible and rejected independently by SQL',async()=>{
  const future=new Date(Date.now()+60_000).toISOString();
  await expect(publishTargetSchedule(database.db,[match],future)).rejects.toThrow('upcoming_source_observations_check');
  const p=await new V1ScheduleTargetRepository(database.db).preview(match.providerMatchId);
  vi.spyOn(V1ScheduleTargetRepository.prototype,'preview').mockResolvedValue({...p,observation:{...p.observation,fetchedAt:future}});
  expect((await get()).json()).toMatchObject({eligible:false,reasons:['SCHEDULE_SOURCE_CLOCK_INVALID']});
});
test('fresh source enables admission; expired schedule preserves exact target and forecast retries',async()=>{
  const req=request(),target=(await post(req)).json(),body={requestId:randomUUID(),scenarioId,expectedRevision:1,targetSha256:target.sha256,targetScope:null};
  const forecast=()=>app.inject({method:'POST',url:`/api/v1/schedule-targets/${req.requestId}/forecasts`,headers:headers(),payload:body});
  const first=await forecast();expect(first.statusCode,first.body).toBe(200);expect(first.json()).toMatchObject({status:'unavailable',teamAWinProbability:null});
  source=await publishTargetSchedule(database.db,[match],new Date(Date.now()-301_000).toISOString());
  expect((await post(req)).json()).toEqual(target);expect((await forecast()).json()).toEqual(first.json());
  const r=await app.inject({method:'POST',url:`/api/v1/schedule-targets/${req.requestId}/forecasts`,headers:headers(),payload:{...body,requestId:randomUUID()}});
  expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe('schedule_source_stale');
  expect((await sql`SELECT 1 FROM prediction_runs`.execute(database.db)).rows).toHaveLength(1);
  source=await publishTargetSchedule(database.db,[match]);expect((await get()).json().eligible).toBe(true);
});
test('CLI/service bypass still rolls back stale forecasts and stale target creation atomically',async()=>{
  const targets=new V1ScheduleTargetRepository(database.db),target=await targets.create(owner,request());
  source=await publishTargetSchedule(database.db,[match],new Date(Date.now()-301_000).toISOString());
  await expect(targets.create(owner,{...request(),expectedRevision:1})).rejects.toThrow('schedule_source_stale');
  const service=await V1PredictionService.open(database.db);
  await expect(service.createScheduled(owner,target.record.request.requestId,{requestId:randomUUID(),scenarioId,expectedRevision:1,
    targetSha256:target.sha256,targetScope:null})).rejects.toThrow('schedule_source_stale');
  expect((await sql`SELECT 1 FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
  expect((await sql`SELECT 1 FROM v1_runtime_snapshots`.execute(database.db)).rows).toHaveLength(0);
  expect(await targets.get(owner,target.record.request.requestId)).toEqual(target);
});
test('freshness is rechecked at persistence when source ages during calculation',async()=>{
  const target=await new V1ScheduleTargetRepository(database.db).create(owner,request());
  const fetchedAt=new Date(Date.now()-296_000).toISOString();await publishTargetSchedule(database.db,[match],fetchedAt);
  const original=V1DataRepository.prototype.exportReleaseInventory;
  vi.spyOn(V1DataRepository.prototype,'exportReleaseInventory').mockImplementation(async function(this:V1DataRepository,...args){
    await new Promise(r=>setTimeout(r,Math.max(0,Date.parse(fetchedAt)+300_050-Date.now())));
    return original.apply(this,args);
  });
  const response=await app.inject({method:'POST',url:`/api/v1/schedule-targets/${target.record.request.requestId}/forecasts`,headers:headers(),
    payload:{requestId:randomUUID(),scenarioId,expectedRevision:1,targetSha256:target.sha256,targetScope:null}});
  expect(response.statusCode,response.body).toBe(409);expect(response.json().error.code).toBe('schedule_source_stale');
  expect((await sql`SELECT 1 FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
});
test('SQL and TypeScript policy agree at exact age/future boundaries',async()=>{
  const fetched='2026-11-05T01:00:00.123Z';
  for(const checked of ['2026-11-05T01:00:00.122999Z','2026-11-05T01:00:00.123000Z','2026-11-05T01:05:00.122999Z','2026-11-05T01:05:00.123000Z']){
    const result=(await sql<{reason:string|null}>`SELECT schedule_source_freshness_reason_v1(${fetched}::timestamptz,${checked}::timestamptz) reason`.execute(database.db)).rows[0]!.reason;
    const expected=scheduleFreshnessReason(fetched,checked);
    expect(result).toBe(expected?.toLowerCase()??null);
  }
});
