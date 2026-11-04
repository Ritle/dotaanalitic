import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { sql, ScenarioRepository, V1RuntimeRepository, V1ForecastOutcomeRepository, MatchContextRepository, V1PredictionService } from '../src/index.js';
import { V1ModelRegistry } from '../src/v1-registry-repository.js';
import { V1ReleaseEvaluationJournal } from '../src/v1-release-journal.js';
import * as computation from '../src/v1-runtime.js';
import * as compatibility from '../src/v1-runtime-code.js';
import { registrySha } from '../src/v1-registry.js';
import { runtimeFixture } from './v1-runtime-fixtures.js';
import { registryFixture } from './v1-registry-fixtures.js';
import { OpenDotaClient, IngestionService } from '../../ingestion/src/index.js';
import {V1JournalRepository} from '../src/v1-journal-repository.js';
import {buildV1JournalV3} from '../src/v1-journal-v3.js';
import {V1TargetLifecycleRepository} from '../src/v1-target-lifecycle.js';
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
  const scenario=await new ScenarioRepository(database.db).save(owner,fixture.input);
  prediction=await new V1RuntimeRepository(database.db).create(owner,{...fixture.request,scenarioId:scenario.id,purpose:'real_map',
    targetScope:{...fixture.request.targetScope,fromAt:'2024-01-01T00:00:00.000Z',until:'2100-01-01T00:00:00.000Z'},
    realTarget:{provider:'opendota',providerSeriesId:'321',mapNumber:1,sourceUrl:'https://example.test/synthetic',rationale:'Synthetic reviewed first-map target'}});
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

it('keeps an unproved map number unlinked and never assumes first observed map is map1',async()=>{
  const result=await refresh(); expect(result.result.status).toBe('unlinked');
  expect(result.result.reasons).toContain('TARGET_MAP_NUMBER_UNVERIFIED'); expect(result.result.outcome).toBeNull();
  const now=new Date().toISOString();
  await new MatchContextRepository(database.db).append({matchId,fact:{field:'map_number',value:1},eventAt:null,knownAt:null,
    fetchedAt:now,availability:'retrospective_fact',earliestStage:'post_match',provider:'synthetic-review',providerRecordId:'synthetic-map1',
    evidenceRef:'https://example.test/synthetic-map1',adapterVersion:'synthetic',reviewState:'accepted'});
  await wait(5);
});
it('links verified pro outcome with original probability; missing roster remains unknown',async()=>{
  await sql`UPDATE match_players SET player_id=NULL WHERE match_id=${matchId}`.execute(database.db);
  const r=await refresh(); expect(r.result).toMatchObject({status:'linked',prospectiveEligible:true,rosterStatus:'unknown',teamASide:'radiant',outcome:{teamAWon:true}});
  expect((await new V1RuntimeRepository(database.db).get(owner,requestId))?.sha256).toBe(prediction.sha256);
});
it('retains mismatched lineups in eligible end-to-end forecasts and recognizes matching sets',async()=>{
  await sql`UPDATE match_players SET player_id=CASE WHEN side='radiant' THEN player_slot+101 ELSE player_slot-22 END WHERE match_id=${matchId}`.execute(database.db);
  expect((await refresh()).result).toMatchObject({rosterStatus:'matched',prospectiveEligible:true});
  await sql`UPDATE match_players SET player_id=NULL WHERE match_id=${matchId} AND player_slot IN (0,128)`.execute(database.db);
  await sql`UPDATE match_players SET player_id=CASE WHEN player_slot=0 THEN 106 ELSE 101 END WHERE match_id=${matchId} AND player_slot IN (0,128)`.execute(database.db);
  expect((await refresh()).result).toMatchObject({rosterStatus:'mismatched',prospectiveEligible:true});
});
it('deduplicates semantic refreshes, preserves exact request retries and rejects stale/changed requests',async()=>{
  const n=(await repo.history(owner,requestId)).length, req={requestId:randomUUID(),predictionRequestId:requestId,matchId,expectedRevision:n};
  const a=await repo.refresh(owner,req), b=await repo.refresh(owner,req); expect(b).toEqual(a); expect(a.revision).toBe(n);
  expect((await repo.history(owner,requestId))).toHaveLength(n);
  await expect(repo.refresh(owner,{...req,matchId:'999'})).rejects.toThrow('forecast_request_conflict');
  await expect(repo.refresh(owner,{...req,requestId:randomUUID(),expectedRevision:0})).rejects.toThrow('CONFLICT');
  await expect(repo.refresh(randomUUID(),{...req,requestId:randomUUID()})).rejects.toThrow('NOT_FOUND');
  await expect(repo.refresh(owner,{...req,requestId:randomUUID(),matchId:'999'})).rejects.toThrow('forecast_bound_map_conflict');
  const concurrent={...req,requestId:randomUUID()};
  const results=await Promise.all([repo.refresh(owner,concurrent),repo.refresh(owner,concurrent)]); expect(results[0]).toEqual(results[1]);
});
it('isolates real-map forecasts from the existing what-if UI and refuses retroactive relabelling',async()=>{
  const service=await V1PredictionService.open(database.db);
  expect((await service.history(owner,prediction.snapshot.scenario.id,0)).items).toHaveLength(0);
  await expect(service.get(owner,prediction.snapshot.scenario.id,requestId)).rejects.toThrow('NOT_FOUND');
  const req={...prediction.snapshot.request,purpose:'what_if_single_map'}; delete (req as {realTarget?:unknown}).realTarget;
  await expect(new V1RuntimeRepository(database.db).create(owner,req)).rejects.toThrow('runtime_request_conflict');
});
it('creates a correction revision from new provider proof, preserving prior label and forecast',async()=>{
  const old=await repo.history(owner,requestId); payload={...payload,radiant_win:false};
  // Reviewed canonical correction first, then matching new source receipt (importer never silently overwrites a conflicting winner).
  await sql`UPDATE matches SET radiant_win=false,data_revision=data_revision+1 WHERE id=${matchId}`.execute(database.db);
  await sql`UPDATE match_players SET player_id=NULL WHERE match_id=${matchId}`.execute(database.db);
  await ingest();
  const r=await refresh(); expect(r.revision).toBe(old.length+1); expect(r.result.outcome?.teamAWon).toBe(false);
  const history=await repo.history(owner,requestId); expect(history.slice(0,old.length)).toEqual(old);
  expect((await new V1RuntimeRepository(database.db).get(owner,requestId))?.sha256).toBe(prediction.sha256);
});
it('excludes a forecast when a verified start correction places issuance after actual start',async()=>{
  const original=payload.start_time; payload={...payload,start_time:Math.floor(Date.parse(prediction.snapshot.createdAt)/1000)-2};
  await sql`UPDATE matches SET started_at=to_timestamp(${payload.start_time as number}),data_revision=data_revision+1 WHERE id=${matchId}`.execute(database.db);
  await ingest(); const late=await refresh(); expect(late.result).toMatchObject({status:'linked',prospectiveEligible:false});
  expect(late.result.reasons).toContain('NOT_BEFORE_ACTUAL_START');
  payload={...payload,start_time:original};
  await sql`UPDATE matches SET started_at=to_timestamp(${original as number}),data_revision=data_revision+1 WHERE id=${matchId}`.execute(database.db);
  await ingest(); expect((await refresh()).result.prospectiveEligible).toBe(true);
});
it('maps A/B by verified native teams and refuses issuing after the series began',async()=>{
  const input=prediction.snapshot.scenario.input, scenario=await new ScenarioRepository(database.db).save(owner,
    {...input,teamAId:input.teamBId,teamBId:input.teamAId,lineupA:input.lineupB,lineupB:input.lineupA});
  const swapped=await new V1RuntimeRepository(database.db).create(owner,{...prediction.snapshot.request,requestId:randomUUID(),scenarioId:scenario.id});
  expect(swapped.snapshot.status).toBe('unavailable'); expect(swapped.snapshot.reasons).toContain('TARGET_SERIES_ALREADY_STARTED');
  const result=await repo.refresh(owner,{requestId:randomUUID(),predictionRequestId:swapped.snapshot.request.requestId,matchId,expectedRevision:0});
  expect(result.result).toMatchObject({status:'linked',prospectiveEligible:false,teamASide:'dire',outcome:{teamAWon:true}});
  expect(result.result.reasons).toContain('NO_ISSUED_PROBABILITY');
  const {realTarget:_,...request}=swapped.snapshot.request as import('@dota/contracts').V1ForecastRequest;
  const hypothetical=await new V1RuntimeRepository(database.db).create(owner,{...request,requestId:randomUUID(),purpose:'what_if_single_map'});
  await expect(repo.refresh(owner,{requestId:randomUUID(),predictionRequestId:hypothetical.snapshot.request.requestId,matchId,expectedRevision:0})).rejects.toThrow('forecast_real_purpose_required');
});
it('does not trust an unmatched canonical correction and cannot rewrite audit rows',async()=>{
  await sql`UPDATE matches SET duration_seconds=2,data_revision=data_revision+1 WHERE id=${matchId}`.execute(database.db);
  const r=await refresh(); expect(r.result.status).toBe('unlinked'); expect(r.result.prospectiveEligible).toBe(false);
  expect(r.result.reasons).toContain('NO_MATCHING_VERIFIED_RECEIPT_AT_SNAPSHOT');
  const forged=JSON.stringify({...r.result,prospectiveEligible:true});
  await expect(sql`INSERT INTO v1_forecast_outcome_revisions(prediction_id,revision,previous_sha256,result_text,result_sha256,content_sha256)
    VALUES(${prediction.id},${r.revision+1},${r.sha256},${forged},${registrySha(forged)},${'a'.repeat(64)})`.execute(database.db)).rejects.toThrow('forecast_verified_result_required');
  for(const statement of [sql`UPDATE v1_forecast_outcome_revisions SET revision=99`,sql`DELETE FROM v1_forecast_outcome_revisions`,
    sql`TRUNCATE v1_forecast_outcome_revisions CASCADE`,sql`DELETE FROM v1_forecast_refresh_requests`]) await expect(statement.execute(database.db)).rejects.toThrow();
});
it('refuses ambiguous source-series mappings instead of selecting a convenient map',async()=>{
  const duplicate=(await sql<{id:string}>`INSERT INTO series(league_id,team_a_id,team_b_id,provider,provider_series_id)
    VALUES(77,11,22,'opendota','321') RETURNING id`.execute(database.db)).rows[0]!.id;
  const result=await refresh(); expect(result.result.reasons).toContain('TARGET_SERIES_UNVERIFIED');
  expect(result.result.prospectiveEligible).toBe(false);
  await sql`DELETE FROM series WHERE id=${duplicate}`.execute(database.db);
});
it('journal freezes empty metrics and verifies all peers before picking primary, including an unrefreshed recalculation',async()=>{
  expect(emptyReport.report.summary.metrics).toMatchObject({n:0,accuracy:null,brier:null,logLoss:null});
  await sql`UPDATE matches SET duration_seconds=1,data_revision=data_revision+1 WHERE id=${matchId}`.execute(database.db);
  const journal=new V1JournalRepository(database.db),result=await journal.create(owner,{requestId:randomUUID(),filters:{}});
  expect(result.report.summary.metrics).toMatchObject({n:1,accuracy:1});expect(result.report.summary.metrics.brier).toBeCloseTo(0.01);
  expect(result.report.summary.rows.find(r=>r.status==='primary')?.predictionId).toBe(recalculation.id);
  const peer=result.input.observations.find(r=>r.id===recalculation.id)!;
  expect(peer.latestOutcome).toBeNull();expect(peer.binding?.matchId).toBe(matchId);
  // More than one peer can have a verified binding (including the A/B-swapped attempt).
  // UUID order is not creation order; require a genuine bound peer, not a particular random UUID.
  expect(peer.binding?.sourcePredictionId).not.toBe(recalculation.id);
  expect((await sql`SELECT 1 FROM v1_forecast_outcome_revisions WHERE prediction_id=${peer.binding!.sourcePredictionId}::uuid
    AND revision=${peer.binding!.revision} AND result_sha256=${peer.binding!.sha256}`.execute(database.db)).rows).toHaveLength(1);
  expect((await repo.history(owner,recalculation.snapshot.request.requestId))).toHaveLength(0);
  expect(result.input.format).toBe('v1-journal-input-v3');
  expect(buildV1JournalV3(result.input,result.report.request.filters)).toEqual(result.report.summary);
  expect((await journal.get(owner,emptyReport.report.request.requestId)).report.summary.metrics.n).toBe(0);
});
it('journal serializes exact retries and versions source corrections without changing old reports',async()=>{
  const journal=new V1JournalRepository(database.db),request={requestId:randomUUID(),filters:{}};
  const [a,b]=await Promise.all([journal.create(owner,request),journal.create(owner,request)]);expect(b).toEqual(a);
  await expect(journal.create(owner,{...request,filters:{status:'primary'}})).rejects.toThrow('journal_request_conflict');
  await expect(journal.get(randomUUID(),request.requestId)).rejects.toThrow('NOT_FOUND');
  // This invalidates current source proof; a fresh report must not reuse the previously verified label.
  await sql`UPDATE matches SET duration_seconds=2,data_revision=data_revision+1 WHERE id=${matchId}`.execute(database.db);
  const changed=await journal.create(owner,{requestId:randomUUID(),filters:{}});
  expect(changed.report.summary.metrics.n).toBe(0);expect(changed.report.summary.counts.unlinked).toBeGreaterThan(0);
  expect(changed.report.previousSha256).toBe(a.sha256);expect((await journal.get(owner,request.requestId))).toEqual(a);
  expect((await journal.create(owner,request))).toEqual(a);
  await sql`UPDATE matches SET duration_seconds=1,data_revision=data_revision+1 WHERE id=${matchId}`.execute(database.db);
});
it('journal retains issued forecasts after model deactivation and cannot rewrite frozen reports',async()=>{
  const registry=new V1ModelRegistry(database.db),model=(await registry.list()).find(m=>m.isActive)!;
  await registry.transition({requestId:randomUUID(),action:'deactivate',modelId:null,expectedCurrentId:model.modelId,reason:'Synthetic journal deactivation check',release:null});
  const journal=new V1JournalRepository(database.db),result=await journal.create(owner,{requestId:randomUUID(),filters:{modelId:model.modelId}});
  expect(result.report.summary.metrics.n).toBe(1);
  for(const query of [sql`UPDATE v1_journal_reports SET revision=999`,sql`DELETE FROM v1_journal_reports`,sql`TRUNCATE v1_journal_reports`])
    await expect(query.execute(database.db)).rejects.toThrow();
});
it('journal rejects foreign or altered prediction inputs at the SQL boundary and recovers after a failed append',async()=>{
  const journal=new V1JournalRepository(database.db),before=await journal.create(owner,{requestId:randomUUID(),filters:{}});
  const request={requestId:randomUUID(),filters:before.report.request.filters},input=structuredClone(before.input);
  input.observations[0]!.probability=0.99;
  const inputText=JSON.stringify(input),report={...before.report,request,revision:before.revision+1,previousSha256:before.sha256,
    inputSha256:registrySha(inputText)},text=JSON.stringify(report);
  await expect(sql`INSERT INTO v1_journal_reports(owner_user_id,request_id,request_hash,revision,previous_sha256,captured_at,
    input_text,input_sha256,report_text,report_sha256) VALUES(${owner},${request.requestId},${'a'.repeat(64)},${report.revision},${before.sha256},
      ${input.capturedAt}::timestamptz,${inputText},${registrySha(inputText)},${text},${registrySha(text)})`.execute(database.db)).rejects.toThrow('journal_prediction_fields_mismatch');
  expect((await journal.create(owner,request)).revision).toBe(before.revision+1);
});
it('manual cancellation cannot hide a losing verified map, even after a later source correction',async()=>{
  const lifecycle=new V1TargetLifecycleRepository(database.db);
  await lifecycle.append(owner,{requestId:randomUUID(),predictionRequestId:requestId,expectedRevision:0,action:'cancelled',eventAt:null,
    sourceUrl:'https://example.test/synthetic-cancel',reason:'Synthetic cancellation after known result'});
  const journal=new V1JournalRepository(database.db),a=await journal.create(owner,{requestId:randomUUID(),filters:{}});
  expect(a.report.summary.metrics.n).toBe(1);expect(a.report.summary.counts.cancelled).toBe(0);
  expect(a.report.summary.rows.find(r=>r.status==='primary')?.reasons).toContain('CANCELLATION_IGNORED_VERIFIED_BINDING');
  await sql`UPDATE matches SET duration_seconds=2,data_revision=data_revision+1 WHERE id=${matchId}`.execute(database.db);
  const b=await journal.create(owner,{requestId:randomUUID(),filters:{}});
  expect(b.report.summary.counts.cancelled).toBe(0);expect(b.report.summary.counts.unlinked).toBeGreaterThan(0);
  expect(await journal.get(owner,a.report.request.requestId)).toEqual(a);
});
