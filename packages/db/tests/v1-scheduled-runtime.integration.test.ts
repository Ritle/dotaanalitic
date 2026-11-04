import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedTargetCatalog,publishTargetSchedule,syntheticTargetMatch} from '../../../tests/helpers/schedule-target.js';
import {sql} from '../src/index.js';
import {ScenarioRepository} from '../src/scenario-repository.js';
import {V1ScheduleTargetRepository} from '../src/v1-schedule-target.js';
import {V1ScheduledLifecycleRepository} from '../src/v1-scheduled-lifecycle.js';
import {V1RuntimeRepository} from '../src/v1-runtime-repository.js';
import {V1ForecastOutcomeRepository} from '../src/v1-forecast-outcomes.js';
import {V1JournalRepository} from '../src/v1-journal-repository.js';
import {journalView} from '../src/v1-journal-reader.js';
import {V1ModelRegistry} from '../src/v1-registry-repository.js';
import {V1ReleaseEvaluationJournal} from '../src/v1-release-journal.js';
import {V1DataRepository} from '../src/v1-data-repository.js';
import {registrySha} from '../src/v1-registry.js';
import {freezeV1ReleaseInventory} from '../src/v1-release-inventory.js';
import * as computation from '../src/v1-runtime.js';
import * as compatibility from '../src/v1-runtime-code.js';
import {runtimeFixture} from './v1-runtime-fixtures.js';
import {registryFixture} from './v1-registry-fixtures.js';
import {v1Fixture} from './v1-data-fixtures.js';
let database:Awaited<ReturnType<typeof testDatabase>>,owner:string;
beforeEach(async()=>{database=await testDatabase();await seedTargetCatalog(database.db);
  owner=(await sql<{id:string}>`INSERT INTO app_users(login,password_hash) VALUES('synthetic-scheduled-runtime',${'x'.repeat(40)}) RETURNING id`.execute(database.db)).rows[0]!.id;
  for(let i=101;i<=110;i++)await sql`INSERT INTO players(id,nickname) VALUES(${String(i)},'Synthetic player')`.execute(database.db);
});
afterEach(async()=>{vi.restoreAllMocks();await database?.close();});
async function fixture(start='2099-01-02T00:00:00.000Z'){
  const f=runtimeFixture(),match=syntheticTargetMatch({scheduledAt:start});await publishTargetSchedule(database.db,[match]);
  const targets=new V1ScheduleTargetRepository(database.db),preview=await targets.preview(match.providerMatchId);
  const target=await targets.create(owner,{requestId:randomUUID(),providerMatchId:match.providerMatchId,observationId:preview.observation.id,
    observationSha256:preview.observation.snapshotSha256,expectedRevision:0,mapNumber:1,providerTeamAId:'74',providerTeamBId:'75',
    teamAId:'11',teamBId:'22',leagueId:'77',reviewSourceUrl:'https://example.test/synthetic-schedule',reason:'Synthetic explicit organization and event mapping'});
  const scenarios=new ScenarioRepository(database.db),input={...f.input,scheduledAt:start,cutoffAt:start,context:{...f.input.context,mapNumber:1}};
  const scenario=await scenarios.save(owner,input),request={...f.request,scenarioId:scenario.id,expectedRevision:scenario.revision,purpose:'real_map' as const,
    targetScope:{...f.request.targetScope!,leagueId:'777',fromAt:'2026-01-01T00:00:00.000Z'},
    realTarget:{provider:'pandascore' as const,bindingVersion:1 as const,providerMatchId:match.providerMatchId,mapNumber:1 as const,
      targetRequestId:target.record.request.requestId,targetSha256:target.sha256}};
  return {targets,target,scenarios,scenario,input,match,request,runtime:new V1RuntimeRepository(database.db)};
}
async function positiveContract(){
  // Synthetic protocol doubles only, never a real model-quality result.
  const f=registryFixture(),registry=new V1ModelRegistry(database.db),model=await registry.register(f.bytes),j=f.journal.journal;
  const reportText=JSON.stringify(f.journal),reportSha=registrySha(reportText);
  await sql`INSERT INTO v1_release_evaluation_journal(plan_fingerprint,plan_sha256,revision,capture_sha256,scorer_sha256,capture_text,report_text,report_sha256,evaluation_status,recorded_at)
    VALUES(${j.planFingerprint},${j.planSha256},1,${j.captureSha256},${j.scorerSha256},${f.captureText},${reportText},${reportSha},'evaluation_complete',${j.recordedAt}::timestamptz)`.execute(database.db);
  vi.spyOn(V1ReleaseEvaluationJournal.prototype,'read').mockResolvedValue({artifact:f.journal,bytes:reportText,sha256:reportSha,captureText:f.captureText});
  await registry.transition({...f.request,modelId:model.modelId});
  const source=v1Fixture(),{request:r,...rest}=source;
  const inventory=freezeV1ReleaseInventory({schemaVersion:1,format:'v1-release-inventory-v1',source:{...rest,request:{fromAt:r.fromAt,toAt:r.toAt,snapshotAt:r.snapshotAt,maxMaps:r.maxMaps}},
    metadata:source.candidates.map(m=>({matchId:m.matchId,leagueId:'77',radiantProviderTeamId:'11',direProviderTeamId:'22'})),inventoryScope:'all_local_maps_remote_completeness_unknown'});
  vi.spyOn(V1DataRepository.prototype,'exportReleaseInventory').mockResolvedValue(inventory);
  vi.spyOn(compatibility,'compatibleV1Runtime').mockReturnValue(true);
  vi.spyOn(computation,'computeV1RuntimeFeatures').mockReturnValue({features:null,probability:0.5000000001,reasons:[]});
  return inventory;
}
it('blocks positive issuance while owner-cancelled, preserves retries and restores ordinary gates after reopening',async()=>{
  const f=await fixture();await positiveContract();const lifecycle=new V1ScheduledLifecycleRepository(database.db);
  const event={requestId:randomUUID(),targetRequestId:f.target.record.request.requestId,expectedRevision:0,action:'cancelled',eventAt:null,
    sourceUrl:'https://example.test/synthetic-cancellation',reason:'Synthetic owner reviewed cancellation'};
  await lifecycle.append(owner,event);const blocked=await f.runtime.create(owner,f.request);
  expect(blocked.snapshot.status).toBe('unavailable');expect(blocked.snapshot.reasons).toContain('TARGET_OWNER_CANCELLED');expect(blocked.snapshot.teamAWinProbability).toBeNull();
  await lifecycle.append(owner,{...event,requestId:randomUUID(),expectedRevision:1,action:'reopened'});
  expect(await f.runtime.create(owner,f.request)).toEqual(blocked);
  const allowed=await f.runtime.create(owner,{...f.request,requestId:randomUUID()});expect(allowed.snapshot.status).toBe('done');
  await publishTargetSchedule(database.db,[{...f.match,status:'running'}]);
  await expect(f.runtime.create(owner,{...f.request,requestId:randomUUID()})).rejects.toThrow();
});
it('freezes target and five-player scenario, returns exact retry after changes and preserves immutable null attempts',async()=>{
  const f=await fixture(),saved=await f.runtime.create(owner,f.request);
  expect(saved.snapshot.reasons).toContain('NO_ACTIVE_MODEL');expect(saved.snapshot.teamAWinProbability).toBeNull();
  expect(saved.snapshot.targetReview).toMatchObject({scheduleBinding:{format:'v1-schedule-runtime-binding-v1',target:f.target}});
  expect(saved.snapshot.scenario.input.lineupA).toEqual(f.input.lineupA);
  await publishTargetSchedule(database.db,[{...f.match,status:'running'}]);
  await f.scenarios.save(owner,{...f.input,title:'Synthetic later edit'},{id:f.scenario.id,expectedRevision:1});
  expect(await f.runtime.create(owner,f.request)).toEqual(saved);
  await expect(f.runtime.create(owner,{...f.request,targetScope:null})).rejects.toThrow('runtime_request_conflict');
  await expect(sql`UPDATE v1_runtime_snapshots SET schedule_target_request_id=NULL WHERE prediction_id=${saved.id}::uuid`.execute(database.db)).rejects.toThrow();
  expect((await sql`SELECT 1 FROM matches`.execute(database.db)).rows).toHaveLength(0);
  const report=await new V1JournalRepository(database.db).create(owner,{requestId:randomUUID(),filters:{}}),view=journalView(report);
  expect(view.summary.counts).toMatchObject({attempts:1,realAttempts:1,whatIfAttempts:0,unavailable:1,primaryMaps:0});
  expect(view.rows[0]!.target).toMatchObject({provider:'pandascore',providerMatchId:f.match.providerMatchId});
});
it('rejects foreign, forged and superseded target references before creating predictions',async()=>{
  const f=await fixture();
  await expect(f.runtime.create(randomUUID(),f.request)).rejects.toThrow('NOT_FOUND');
  for(const patch of [{targetSha256:'a'.repeat(64)},{providerMatchId:'1'}])
    await expect(f.runtime.create(owner,{...f.request,realTarget:{...f.request.realTarget,...patch}})).rejects.toThrow('scheduled_target_reference_mismatch');
  await f.targets.create(owner,{...f.target.record.request,requestId:randomUUID(),expectedRevision:1,reason:'Synthetic reviewed newer mapping revision'});
  await expect(f.runtime.create(owner,f.request)).rejects.toThrow('scheduled_target_revision_changed');
  expect((await sql`SELECT 1 FROM prediction_runs`.execute(database.db)).rows).toHaveLength(0);
});
it('requires exact canonical orientation, event, scheduled time and explicit first map',async()=>{
  const f=await fixture();
  for(const input of [{...f.input,teamAId:'22',teamBId:'11'},
    {...f.input,context:{...f.input.context,leagueId:null}},
    {...f.input,scheduledAt:'2099-01-03T00:00:00.000Z'},
    {...f.input,context:{...f.input.context,mapNumber:null}}]){
    const s=await f.scenarios.save(owner,input);
    await expect(f.runtime.create(owner,{...f.request,requestId:randomUUID(),scenarioId:s.id})).rejects.toThrow('scheduled_target_scenario_mismatch');
  }
  const swapped=await f.targets.create(owner,{...f.target.record.request,requestId:randomUUID(),expectedRevision:1,
    providerTeamAId:'75',providerTeamBId:'74',teamAId:'22',teamBId:'11'});
  const s=await f.scenarios.save(owner,{...f.input,teamAId:'22',teamBId:'11',lineupA:f.input.lineupB,lineupB:f.input.lineupA});
  const result=await f.runtime.create(owner,{...f.request,requestId:randomUUID(),scenarioId:s.id,
    realTarget:{...f.request.realTarget,targetRequestId:swapped.record.request.requestId,targetSha256:swapped.sha256}});
  expect(result.snapshot.scenario.input.lineupA).toEqual(f.input.lineupB);
});
it('accepts identical refreshed meeting and omission warnings but rejects changed meeting and started sources',async()=>{
  const f=await fixture();await publishTargetSchedule(database.db,[f.match]);await publishTargetSchedule(database.db,[]);
  const saved=await f.runtime.create(owner,f.request);
  expect(saved.snapshot.targetReview).toMatchObject({scheduleBinding:{omittingLaterPages:1}});
  const b=(saved.snapshot.targetReview as {scheduleBinding:{currentObservation:{id:string}}}).scheduleBinding;
  expect(b.currentObservation.id).not.toBe(f.target.record.observation.id);
  await publishTargetSchedule(database.db,[{...f.match,scheduledAt:'2099-01-03T00:00:00.000Z'}]);
  await expect(f.runtime.create(owner,{...f.request,requestId:randomUUID()})).rejects.toThrow('scheduled_target_source_changed');
  await publishTargetSchedule(database.db,[{...f.match,status:'running'}]);
  await expect(f.runtime.create(owner,{...f.request,requestId:randomUUID()})).rejects.toThrow('scheduled_target_not_upcoming');
});
it('issues only with the unchanged positive model protocol, journals pending and refuses unverified map binding',async()=>{
  await positiveContract();const f=await fixture();const [a,b]=await Promise.all([f.runtime.create(owner,f.request),f.runtime.create(owner,f.request)]);
  expect(a).toEqual(b);expect(a.snapshot.teamAWinProbability).toBe(0.5000000001);expect(a.snapshot.status).toBe('done');
  const reports=new V1JournalRepository(database.db),report=await reports.create(owner,{requestId:randomUUID(),filters:{}});
  expect(report.report.summary.counts).toMatchObject({realAttempts:1,issued:1,pendingVerification:1,primaryMaps:0});
  expect(report.report.summary.metrics.n).toBe(0);
  await expect(new V1ForecastOutcomeRepository(database.db).refresh(owner,{requestId:randomUUID(),predictionRequestId:f.request.requestId,matchId:'1',expectedRevision:0}))
    .rejects.toThrow('forecast_schedule_binding_required');
  const unbound=(await sql<{result:{status:string;reasons:string[]}}>`SELECT verify_v1_forecast_outcome(${a.id}::uuid,1,date_trunc('milliseconds',clock_timestamp())) AS result`.execute(database.db)).rows[0]!.result;
  expect(unbound).toMatchObject({status:'unlinked',reasons:['SCHEDULE_BINDING_REQUIRED']});
  expect((await reports.get(owner,report.report.request.requestId)).sha256).toBe(report.sha256);
});
it('preserves Tier1 and code-compatibility vetoes for the new selector',async()=>{
  await positiveContract();const f=await fixture();
  const missing=await f.runtime.create(owner,{...f.request,targetScope:null});expect(missing.snapshot.reasons).toContain('TIER1_SCOPE_NOT_REVIEWED');
  vi.mocked(compatibility.compatibleV1Runtime).mockReturnValue(false);
  const mismatch=await f.runtime.create(owner,{...f.request,requestId:randomUUID()});expect(mismatch.snapshot.reasons).toContain('INFERENCE_CODE_MISMATCH');
  expect(missing.snapshot.teamAWinProbability).toBeNull();expect(mismatch.snapshot.teamAWinProbability).toBeNull();
});
it('owner CLI creates and reads an unavailable scheduled forecast with the same UUID and no fabricated map',async()=>{
  const f=await fixture(),dir=await mkdtemp(join(tmpdir(),'synthetic-scheduled-cli-'));
  try{
    const path=join(dir,'request.json'),bytes=JSON.stringify(f.request);await writeFile(path,bytes);
    const run=(args:string[])=>promisify(execFile)(process.execPath,['scripts/v1-forecast.mjs',...args],
      {cwd:fileURLToPath(new URL('../../../',import.meta.url)),env:{...process.env,DATABASE_URL:database.url},windowsHide:true,timeout:20000});
    const first=JSON.parse((await run(['create',path,registrySha(bytes)])).stdout);
    expect(first.status).toBe('unavailable');expect(first.target).toEqual(f.request.realTarget);
    expect(JSON.parse((await run(['get',f.request.requestId])).stdout)).toEqual(first);
    expect(JSON.parse((await run(['create',path,registrySha(bytes)])).stdout)).toEqual(first);
    expect((await sql`SELECT 1 FROM prediction_runs`.execute(database.db)).rows).toHaveLength(1);
  }finally{const target=resolve(dir);if(!target.startsWith(resolve(tmpdir())+sep))throw Error('unsafe_cleanup');await rm(target,{recursive:true,force:true});}
});
it('refuses SQL binding forgery independently and retains pending records after time crosses start during computation',async()=>{
  const inventory=await positiveContract(),f=await fixture(new Date(Date.now()+3000).toISOString());
  vi.mocked(V1DataRepository.prototype.exportReleaseInventory).mockImplementation(async()=>{await new Promise(r=>setTimeout(r,3500));return inventory;});
  const result=await f.runtime.create(owner,f.request);expect(result.snapshot.status).toBe('unavailable');expect(result.snapshot.reasons).toContain('TARGET_ALREADY_STARTED');
  expect(result.snapshot.teamAWinProbability).toBeNull();
  // Fresh source/clock is required even for a direct SQL caller; original snapshot stays unchanged.
  const forged=JSON.parse(JSON.stringify(result.snapshot));forged.request.realTarget.targetSha256='0'.repeat(64);
  await expect(database.db.transaction().execute(async tx=>{
    const at=(await sql<{at:string}>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at`.execute(tx)).rows[0]!.at;
    forged.createdAt=at;forged.targetReview.scheduleBinding.checkedAt=at;
    await sql`SELECT validate_v1_scheduled_runtime(${owner}::uuid,${f.request.realTarget.targetRequestId}::uuid,${JSON.stringify(forged)}::jsonb)`.execute(tx);
  })).rejects.toThrow('scheduled_target_reference_mismatch');
  expect((await f.runtime.get(owner,f.request.requestId))!.sha256).toBe(result.sha256);
});
