import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {seedTargetCatalog,syntheticTargetMatch} from '../../../tests/helpers/schedule-target.js';
import {sql} from '../src/index.js';
import {ScenarioRepository} from '../src/scenario-repository.js';
import {PageScheduleTargetRepository} from '../src/schedule-page-targets.js';
import {V1ScheduledLifecycleRepository} from '../src/v1-scheduled-lifecycle.js';
import {PageScheduledRuntimeRepository} from '../src/schedule-page-runtime.js';
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
  const targets=new PageScheduleTargetRepository(database.db),preview=await targets.preview(match.providerMatchId);
  const target=await targets.create(owner,{requestId:randomUUID(),providerMatchId:match.providerMatchId,observationId:preview.observation.id,
    observationSha256:preview.observation.snapshotSha256,expectedRevision:0,mapNumber:1,providerTeamAId:'74',providerTeamBId:'75',
    teamAId:'11',teamBId:'22',leagueId:'77',reviewSourceUrl:'https://example.test/synthetic-schedule',reason:'Synthetic explicit organization and event mapping'});
  const scenarios=new ScenarioRepository(database.db),input={...f.input,scheduledAt:start,cutoffAt:start,context:{...f.input.context,mapNumber:1}};
  const scenario=await scenarios.save(owner,input),request={...f.request,scenarioId:scenario.id,expectedRevision:scenario.revision,purpose:'real_map' as const,
    targetScope:{...f.request.targetScope!,leagueId:'777',fromAt:'2026-01-01T00:00:00.000Z'},
    realTarget:{provider:'pandascore' as const,bindingVersion:1 as const,providerMatchId:match.providerMatchId,mapNumber:1 as const,
      targetRequestId:target.record.request.requestId,targetSha256:target.sha256}};
  return {targets,target,scenarios,scenario,input,match,request,runtime:new PageScheduledRuntimeRepository(database.db)};
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
  expect(saved.snapshot.targetReview).toMatchObject({scheduleBinding:{format:'v1-schedule-runtime-binding-v2',target:f.target}});
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

// Synthetic model/gate doubles exercise transactional contracts, not actual quality.
async function publishTargetSchedule(db:typeof database.db,data:ReturnType<typeof syntheticTargetMatch>[]){
 const snapshot={data,source:{provider:'pandascore',adapterVersion:'synthetic-page-runtime',
  endpoint:'/dota2/matches/upcoming?sort=scheduled_at,id&page=2&per_page=20',fetchedAt:new Date().toISOString(),
  knownAt:null,payloadSha256:'c'.repeat(64),attempts:1,rateLimitRemaining:null}},text=JSON.stringify(snapshot);
 await sql`INSERT INTO upcoming_page_observations(page,source_endpoint,source_payload_sha256,source_fetched_at,snapshot_sha256,snapshot_text)
 VALUES(2,${snapshot.source.endpoint},${snapshot.source.payloadSha256},${snapshot.source.fetchedAt},${registrySha(text)},${text})`.execute(db);
}
