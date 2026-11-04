import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {V1ScheduleTargetRepository,V1ScheduleResultRepository} from '../src/index.js';
import {publishTargetSchedule,syntheticTargetMatch} from '../../../tests/helpers/schedule-target.js';
import {journalView} from '../src/v1-journal-reader.js';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { sql, ScenarioRepository, V1RuntimeRepository, V1ForecastOutcomeRepository, MatchContextRepository } from '../src/index.js';
import { V1ModelRegistry } from '../src/v1-registry-repository.js';
import { V1ReleaseEvaluationJournal } from '../src/v1-release-journal.js';
import * as computation from '../src/v1-runtime.js';
import * as compatibility from '../src/v1-runtime-code.js';
import { registrySha } from '../src/v1-registry.js';
import { runtimeFixture } from './v1-runtime-fixtures.js';
import { registryFixture } from './v1-registry-fixtures.js';
import { OpenDotaClient, IngestionService } from '../../ingestion/src/index.js';
import {V1JournalRepository} from '../src/v1-journal-repository.js';
let database: Awaited<ReturnType<typeof testDatabase>>, owner:string, prediction:Awaited<ReturnType<V1RuntimeRepository['create']>>;
let repo:V1ForecastOutcomeRepository, requestId:string, payload:Record<string,unknown>, seriesId:string;
let recalculation:Awaited<ReturnType<V1RuntimeRepository['create']>>,emptyReport:Awaited<ReturnType<V1JournalRepository['create']>>;
const matchId='9007199254742301';
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function ingest() {
  const client=new OpenDotaClient({}, {fetch:async url=>new Response(JSON.stringify(url.pathname==='/api/heroes'?
    Array.from({length:10},(_,i)=>({id:i+1,name:`synthetic_${i}`,localized_name:`Synthetic ${i}`})):
    url.pathname==='/api/leagues'?[{leagueid:77,name:'Synthetic league',tier:'professional'}]:payload))});
  return new IngestionService(database.db,client).ingest(matchId);
}
async function refresh(id=matchId) {
  const history=await repo.history(owner,requestId);
  return repo.refresh(owner,{requestId:randomUUID(),predictionRequestId:requestId,matchId:id,expectedRevision:history.length});
}
beforeAll(async()=>{
  database=await testDatabase(); repo=new V1ForecastOutcomeRepository(database.db);
  owner=(await sql<{id:string}>`INSERT INTO app_users(login,password_hash) VALUES('synthetic-forecast',${'x'.repeat(40)}) RETURNING id`.execute(database.db)).rows[0]!.id;
  emptyReport=await new V1JournalRepository(database.db).create(owner,{requestId:randomUUID(),filters:{}});
  await sql`INSERT INTO teams(id,name,opendota_team_id) VALUES(11,'Synthetic A',111),(22,'Synthetic B',222)`.execute(database.db);
  await sql`INSERT INTO leagues(id,opendota_league_id,name) VALUES(77,77,'Synthetic event')`.execute(database.db);
  for(let i=101;i<=110;i++) await sql`INSERT INTO players(id,nickname) VALUES(${String(i)},'Synthetic')`.execute(database.db);
  // Explicit synthetic protocol doubles for runtime issuance, not model quality evidence.
  const f=registryFixture(), registry=new V1ModelRegistry(database.db), model=await registry.register(f.bytes), j=f.journal.journal;
  const text=JSON.stringify(f.journal), sha=registrySha(text);
  await sql`INSERT INTO v1_release_evaluation_journal(plan_fingerprint,plan_sha256,revision,capture_sha256,scorer_sha256,
    capture_text,report_text,report_sha256,evaluation_status,recorded_at)
    VALUES(${j.planFingerprint},${j.planSha256},1,${j.captureSha256},${j.scorerSha256},${f.captureText},${text},${sha},'evaluation_complete',${j.recordedAt}::timestamptz)`.execute(database.db);
  vi.spyOn(V1ReleaseEvaluationJournal.prototype,'read').mockResolvedValue({artifact:f.journal,bytes:text,sha256:sha,captureText:f.captureText});
  await registry.transition({...f.request,modelId:model.modelId});
  vi.spyOn(compatibility,'compatibleV1Runtime').mockReturnValue(true);
  // Empty real-profile inventory is enough for this synthetic scorer double.
  vi.spyOn(computation,'computeV1RuntimeFeatures').mockReturnValue({features:null,probability:0.61,reasons:[]});
  const fixture=runtimeFixture(), now=Date.now();
  fixture.input.scheduledAt=new Date(now+3600000).toISOString(); fixture.input.cutoffAt=new Date(now+60000).toISOString();
  fixture.input.context.mapNumber=1;
  const meeting=syntheticTargetMatch({scheduledAt:fixture.input.scheduledAt});await publishTargetSchedule(database.db,[meeting]);
  const targets=new V1ScheduleTargetRepository(database.db),preview=await targets.preview(meeting.providerMatchId);
  const target=await targets.create(owner,{requestId:randomUUID(),providerMatchId:meeting.providerMatchId,observationId:preview.observation.id,
    observationSha256:preview.observation.snapshotSha256,expectedRevision:0,mapNumber:1,providerTeamAId:'74',providerTeamBId:'75',
    teamAId:'11',teamBId:'22',leagueId:'77',reviewSourceUrl:'https://example.test/synthetic-review',reason:'Synthetic reviewed schedule mapping'});
  const scenario=await new ScenarioRepository(database.db).save(owner,fixture.input);
  prediction=await new V1RuntimeRepository(database.db).create(owner,{...fixture.request,scenarioId:scenario.id,purpose:'real_map',
    targetScope:{...fixture.request.targetScope,fromAt:'2024-01-01T00:00:00.000Z',until:'2100-01-01T00:00:00.000Z'},
    realTarget:{provider:'pandascore',bindingVersion:1,mapNumber:1,providerMatchId:meeting.providerMatchId,targetRequestId:target.record.request.requestId,targetSha256:target.sha256}});
  expect(prediction.snapshot.status).toBe('done'); requestId=prediction.snapshot.request.requestId;
  vi.mocked(computation.computeV1RuntimeFeatures).mockReturnValue({features:null,probability:0.1,reasons:[]});
  recalculation=await new V1RuntimeRepository(database.db).create(owner,{...prediction.snapshot.request,requestId:randomUUID()});
  expect(recalculation.snapshot.status).toBe('done');
  vi.mocked(computation.computeV1RuntimeFeatures).mockReturnValue({features:null,probability:0.61,reasons:[]});
  // The actual start is later than issuance, even if the scheduled time changes.
  const start=Math.ceil(Date.now()/1000)+1;
  payload={match_id:matchId,start_time:start,duration:1,radiant_win:true,radiant_team_id:111,dire_team_id:222,leagueid:77,series_id:321,
    players:Array.from({length:10},(_,i)=>({player_slot:i<5?i:i+123,hero_id:i+1,account_id:100001+i}))};
  await wait(start*1000+1100-Date.now()); await ingest();
  seriesId=(await sql<{id:string}>`INSERT INTO series(league_id,team_a_id,team_b_id,provider,provider_series_id) VALUES(77,11,22,'opendota','321') RETURNING id`.execute(database.db)).rows[0]!.id;
  await sql`UPDATE matches SET series_id=${seriesId},map_number=1 WHERE id=${matchId}`.execute(database.db);
},60000);
afterAll(async()=>{vi.restoreAllMocks();await database?.close();},30000);

const bindingRequest=()=>({requestId:randomUUID(),predictionRequestId:requestId,targetSha256:
  prediction.snapshot.request.purpose==='real_map'&&prediction.snapshot.request.realTarget.provider==='pandascore'?prediction.snapshot.request.realTarget.targetSha256:'',
  matchId,providerSeriesId:'321',sourceUrl:'https://example.test/synthetic-cross-provider-proof',rationale:'Synthetic owner-reviewed association of exactly this meeting and first map'});
let binding:Awaited<ReturnType<V1ScheduleResultRepository['bind']>>,firstReport:Awaited<ReturnType<V1JournalRepository['create']>>;
let lateBeforeBinding:Awaited<ReturnType<V1RuntimeRepository['create']>>;
it('requires a reviewed association and independent proof of map1 before accepting a result',async()=>{
  await expect(refresh()).rejects.toThrow('forecast_schedule_binding_required');
  await expect(new V1ScheduleResultRepository(database.db).bind(owner,bindingRequest())).rejects.toThrow('schedule_result_map_unverified');
  const now=new Date().toISOString();
  await new MatchContextRepository(database.db).append({matchId,fact:{field:'map_number',value:1},eventAt:null,knownAt:null,fetchedAt:now,
    availability:'retrospective_fact',earliestStage:'post_match',provider:'synthetic-review',providerRecordId:'synthetic-map1',
    evidenceRef:'https://example.test/synthetic-map1',adapterVersion:'synthetic',reviewState:'accepted'});
  await wait(5);
  lateBeforeBinding=await new V1RuntimeRepository(database.db).create(owner,{...prediction.snapshot.request,requestId:randomUUID()});
  expect(lateBeforeBinding.snapshot.status).toBe('done');
});
it('binds concurrently once, verifies both recalculations and counts only one actual map',async()=>{
  const r=bindingRequest(),service=new V1ScheduleResultRepository(database.db);
  const results=await Promise.all([service.bind(owner,r),service.bind(owner,r)]);expect(results[0]).toEqual(results[1]);binding=results[0]!;
  expect(binding.record.verification).toMatchObject({status:'linked',prospectiveEligible:true,outcome:{teamAWon:true}});
  await wait(5);const outcome=await refresh();expect(outcome.result.scheduleBinding).toMatchObject({sha256:binding.sha256,matchId,providerSeriesId:'321'});
  firstReport=await new V1JournalRepository(database.db).create(owner,{requestId:randomUUID(),filters:{}});
  expect(firstReport.report.summary.metrics.n).toBe(1);expect(firstReport.report.summary.counts.issued).toBe(3);
  expect(firstReport.input.observations.find(r=>r.id===lateBeforeBinding.id)?.verification).toMatchObject({prospectiveEligible:false,reasons:['NOT_BEFORE_ACTUAL_START']});
  expect(firstReport.report.summary.rows.find(r=>r.predictionId===recalculation.id)?.status).toBe('primary');
  expect(journalView(firstReport).rows.every(r=>r.scheduleResultBinding?.sha256===binding.sha256)).toBe(true);
  expect((await new V1RuntimeRepository(database.db).get(owner,requestId))?.sha256).toBe(prediction.sha256);
  const past=await new V1RuntimeRepository(database.db).create(owner,{...prediction.snapshot.request,requestId:randomUUID()});
  expect(past.snapshot.status).toBe('unavailable');
  expect(past.snapshot.reasons).toContain('TARGET_SERIES_ALREADY_STARTED');
  await expect(sql`SELECT guard_v1_scheduled_issuance(${owner}::uuid,${binding.record.target.providerMatchId}::bigint,'done')`.execute(database.db))
    .rejects.toThrow('forecast_target_already_started_or_ambiguous');
});
it('preserves exact retries and rejects foreign owners, altered requests, target hashes and series',async()=>{
  const service=new V1ScheduleResultRepository(database.db),r=binding.record.request;
  expect(await service.bind(owner,r)).toEqual(binding);expect(await service.get(owner,r.requestId)).toEqual(binding);
  await expect(service.bind(owner,{...r,matchId:'999'})).rejects.toThrow('schedule_result_request_conflict');
  await expect(service.get(randomUUID(),r.requestId)).rejects.toThrow('NOT_FOUND');
  await expect(service.bind(randomUUID(),{...r,requestId:randomUUID()})).rejects.toThrow('NOT_FOUND');
  await expect(service.bind(owner,{...r,requestId:randomUUID(),targetSha256:'a'.repeat(64)})).rejects.toThrow('schedule_result_target_mismatch');
  await expect(service.bind(owner,{...r,requestId:randomUUID(),providerSeriesId:'999'})).rejects.toThrow('schedule_result_map_unverified');
  await expect(service.bind(owner,{...r,requestId:randomUUID()})).rejects.toThrow('schedule_result_already_bound');
  await expect(sql`UPDATE v1_schedule_result_bindings SET provider_series_id='999'`.execute(database.db)).rejects.toThrow();
  await expect(sql`TRUNCATE v1_schedule_result_bindings`.execute(database.db)).rejects.toThrow();
  const wrong=(await sql<{r:{reasons:string[];status:string}}>`SELECT verify_v1_forecast_outcome(${prediction.id}::uuid,999,date_trunc('milliseconds',clock_timestamp())) r`.execute(database.db)).rows[0]!.r;
  expect(wrong).toMatchObject({status:'unlinked',reasons:['SCHEDULE_BOUND_MAP_MISMATCH']});
});
it('keeps missing and mismatched actual lineups separate without removing genuine pre-start forecasts',async()=>{
  await sql`UPDATE match_players SET player_id=NULL WHERE match_id=${matchId}`.execute(database.db);
  expect((await refresh()).result).toMatchObject({rosterStatus:'unknown',prospectiveEligible:true});
  await sql`UPDATE match_players SET player_id=CASE WHEN side='radiant' THEN player_slot+101 ELSE player_slot-22 END WHERE match_id=${matchId}`.execute(database.db);
  expect((await refresh()).result).toMatchObject({rosterStatus:'matched',prospectiveEligible:true});
  await sql`UPDATE match_players SET player_id=NULL WHERE match_id=${matchId} AND player_slot IN (0,128)`.execute(database.db);
  await sql`UPDATE match_players SET player_id=CASE WHEN player_slot=0 THEN 106 ELSE 101 END WHERE match_id=${matchId} AND player_slot IN (0,128)`.execute(database.db);
  expect((await refresh()).result).toMatchObject({rosterStatus:'mismatched',prospectiveEligible:true});
});
it('isolates a new target revision until reviewed, rejects forged SQL proof and supports real owner CLI binding',async()=>{
  const ref=prediction.snapshot.request;
  if(ref.purpose!=='real_map'||ref.realTarget.provider!=='pandascore')throw Error('fixture');
  const targets=new V1ScheduleTargetRepository(database.db),original=await targets.get(owner,ref.realTarget.targetRequestId);
  const target=await targets.create(owner,{...original.record.request,requestId:randomUUID(),expectedRevision:1,reason:'Synthetic second reviewed target revision'});
  const late=await new V1RuntimeRepository(database.db).create(owner,{...ref,requestId:randomUUID(),realTarget:{...ref.realTarget,targetRequestId:target.record.request.requestId,targetSha256:target.sha256}});
  expect(late.snapshot.status).toBe('unavailable');expect(late.snapshot.reasons).toContain('TARGET_SERIES_ALREADY_STARTED');
  if(late.snapshot.request.purpose!=='real_map')throw Error('fixture');
  const lateTarget=late.snapshot.request.realTarget;
  const report=await new V1JournalRepository(database.db).create(owner,{requestId:randomUUID(),filters:{}});
  expect(report.report.summary.metrics.n).toBe(1);
  expect(report.input.observations.find(r=>r.id===late.id)?.verification?.reasons).toContain('SCHEDULE_BINDING_REQUIRED');
  const r={...bindingRequest(),predictionRequestId:late.snapshot.request.requestId,targetSha256:target.sha256};
  await expect(database.db.transaction().execute(async tx=>{
    const time=(await sql<{t:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') t`.execute(tx)).rows[0]!.t;
    const value={...binding.record,request:r,predictionId:late.id,target:lateTarget,reviewedAt:time};
    const text=JSON.stringify(value);
    await sql`INSERT INTO v1_schedule_result_bindings(owner_user_id,request_id,request_hash,target_request_id,provider_match_id,prediction_id,match_id,provider_series_id,record_text,record_sha256)
      VALUES(${owner}::uuid,${r.requestId}::uuid,${'a'.repeat(64)},${target.record.request.requestId}::uuid,${ref.realTarget.providerMatchId},${late.id}::uuid,${matchId},'321',${text},${registrySha(text)})`.execute(tx);
  })).rejects.toThrow('schedule_result_map_unverified');
  const dir=await mkdtemp(join(tmpdir(),'dota-result-cli-')),root=fileURLToPath(new URL('../../../',import.meta.url));
  try{
    const bytes=JSON.stringify(r),path=join(dir,'request.json');await writeFile(path,bytes);
    const run=(...args:string[])=>promisify(execFile)(process.execPath,['scripts/v1-forecast.mjs',...args],{cwd:root,env:{...process.env,DATABASE_URL:database.url},windowsHide:true});
    const created=JSON.parse((await run('bind',path,registrySha(bytes))).stdout);
    expect(JSON.parse((await run('binding',r.requestId)).stdout)).toEqual(created);
    expect(JSON.parse((await run('bind',path,registrySha(bytes))).stdout)).toEqual(created);
    await wait(5);const outcome=await repo.refresh(owner,{requestId:randomUUID(),predictionRequestId:r.predictionRequestId,matchId,expectedRevision:0});
    expect(outcome.result).toMatchObject({status:'linked',prospectiveEligible:false,reasons:['NO_ISSUED_PROBABILITY']});
    expect((await new V1JournalRepository(database.db).create(owner,{requestId:randomUUID(),filters:{}})).report.summary.metrics.n).toBe(1);
  }finally{if(!resolve(dir).startsWith(resolve(tmpdir())+sep))throw Error('unsafe_test_cleanup');await rm(dir,{recursive:true,force:true});}
},30000);
it('records verified source corrections in new revisions while replaying old reports and bindings exactly',async()=>{
  payload={...payload,radiant_win:false};await sql`UPDATE matches SET radiant_win=false,data_revision=data_revision+1 WHERE id=${matchId}`.execute(database.db);
  await ingest();await wait(5);
  const outcome=await refresh();expect(outcome.result).toMatchObject({status:'linked',outcome:{teamAWon:false},scheduleBinding:{sha256:binding.sha256}});
  const reports=new V1JournalRepository(database.db),newReport=await reports.create(owner,{requestId:randomUUID(),filters:{}});
  expect(newReport.report.summary.metrics.n).toBe(1);expect(newReport.report.summary.metrics.accuracy).not.toBe(firstReport.report.summary.metrics.accuracy);
  expect(await reports.get(owner,firstReport.report.request.requestId)).toEqual(firstReport);
  expect(await reports.get(owner,emptyReport.report.request.requestId)).toEqual(emptyReport);
  expect(await new V1ScheduleResultRepository(database.db).get(owner,binding.record.request.requestId)).toEqual(binding);
  expect((await new V1RuntimeRepository(database.db).get(owner,requestId))?.sha256).toBe(prediction.sha256);
});
it('maps explicitly reversed A/B through native sides and prevents another meeting claiming the same map',async()=>{
  const ref=prediction.snapshot.request;if(ref.purpose!=='real_map'||ref.realTarget.provider!=='pandascore')throw Error('fixture');
  const targets=new V1ScheduleTargetRepository(database.db),service=new V1ScheduleResultRepository(database.db);
  for(const alias of [false,true]){
    const meeting=syntheticTargetMatch({providerMatchId:alias?'9007199254743000':ref.realTarget.providerMatchId,scheduledAt:prediction.snapshot.scenario.input.scheduledAt});
    await publishTargetSchedule(database.db,[meeting]);const preview=await targets.preview(meeting.providerMatchId);
    const target=await targets.create(owner,{requestId:randomUUID(),providerMatchId:meeting.providerMatchId,observationId:preview.observation.id,
      observationSha256:preview.observation.snapshotSha256,expectedRevision:alias?0:2,mapNumber:1,providerTeamAId:'75',providerTeamBId:'74',
      teamAId:'22',teamBId:'11',leagueId:'77',reviewSourceUrl:'https://example.test/synthetic-swapped',reason:'Synthetic explicit reversed canonical orientation'});
    const input=prediction.snapshot.scenario.input,scenario=await new ScenarioRepository(database.db).save(owner,{...input,teamAId:'22',teamBId:'11',lineupA:input.lineupB,lineupB:input.lineupA});
    const p=await new V1RuntimeRepository(database.db).create(owner,{...ref,requestId:randomUUID(),scenarioId:scenario.id,realTarget:{...ref.realTarget,
      providerMatchId:meeting.providerMatchId,targetRequestId:target.record.request.requestId,targetSha256:target.sha256}});
    const r={...bindingRequest(),predictionRequestId:p.snapshot.request.requestId,targetSha256:target.sha256};
    if(alias)await expect(service.bind(owner,r)).rejects.toThrow('schedule_result_map_conflict');
    else expect((await service.bind(owner,r)).record.verification).toMatchObject({status:'linked',teamASide:'dire',outcome:{teamAWon:true}});
  }
});

