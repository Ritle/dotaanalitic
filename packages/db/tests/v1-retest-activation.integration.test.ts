import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from 'vitest';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { sql } from '../src/index.js';
import { RetestModelRegistry } from '../src/v1-retest-registry-repository.js';
import { RetestActivationRegistry } from '../src/v1-retest-activation-repository.js';
import { PredictionModelRegistry } from '../src/v1-model-runtime.js';
import { verifyRetestRegistryEvidence } from '../src/v1-retest-registry-verifier.js';
import * as code from '../src/v1-retest-runtime-code.js';
import { retestRegistryFixture } from './v1-retest-registry-fixture.js';
import { ScenarioRepository } from '../src/scenario-repository.js';
import { V1RuntimeRepository } from '../src/v1-runtime-repository.js';
import { PageScheduledRuntimeRepository } from '../src/schedule-page-runtime.js';
import { V1DataRepository } from '../src/v1-data-repository.js';
import { freezeV1ReleaseInventory } from '../src/v1-release-inventory.js';
import { predictionView } from '../src/v1-prediction-reader.js';
import { registrySha } from '../src/v1-registry.js';
import * as computation from '../src/v1-model-runtime.js';
import { runtimeFixture } from './v1-runtime-fixtures.js';
import { v1Fixture } from './v1-data-fixtures.js';
vi.mock('../src/v1-retest-registry-verifier.js', async original => ({
  ...await original<typeof import('../src/v1-retest-registry-verifier.js')>(), verifyRetestRegistryEvidence: vi.fn()
}));
let database: Awaited<ReturnType<typeof testDatabase>>, registry: RetestActivationRegistry;
let owner: string;
const fixtures = new Map<string, ReturnType<typeof retestRegistryFixture>>();
beforeAll(async () => {
  database = await testDatabase(); registry = new RetestActivationRegistry(database.db);
  owner = (await sql<{ id: string }>`INSERT INTO app_users(login,password_hash) VALUES ('synthetic-retest',${'x'.repeat(40)}) RETURNING id`.execute(database.db)).rows[0]!.id;
  await sql`INSERT INTO teams(id,name) VALUES (11,'Synthetic A'),(22,'Synthetic B')`.execute(database.db);
  await sql`INSERT INTO leagues(id,opendota_league_id,name) VALUES (77,77,'Synthetic scope')`.execute(database.db);
  for (let i=101;i<=110;i++) await sql`INSERT INTO players(id,nickname) VALUES (${String(i)},'Synthetic player')`.execute(database.db);
}, 30000);
beforeEach(() => {
  vi.mocked(verifyRetestRegistryEvidence).mockImplementation(async input => {
    const f = fixtures.get(input.freeze.sha256); if (!f) throw Error('synthetic_test_fixture_missing'); return f.metadata;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  const id = (await sql<{ id: string }>`SELECT id FROM prediction_model_versions WHERE is_active`.execute(database.db)).rows[0]?.id;
  if (id) await registry.transition({ requestId: randomUUID(), action: 'deactivate', modelId: null, expectedCurrentId: id,
    reason: 'Synthetic isolated test cleanup', evidence: null });
});
afterAll(async () => { await database?.close(); });
async function model() {
  // Explicit DB protocol double. Production source replay is independently tested and rejects this capsule.
  const f = retestRegistryFixture(); f.metadata.runtime = (await code.readRetestRuntimeCode()).runtime.runtime;
  fixtures.set(f.evidence.freeze.sha256, f);
  const registered = await new RetestModelRegistry(database.db).register(f.evidence);
  return { ...f, id: registered.modelId, request: { requestId: randomUUID(), action: 'promote' as const, modelId: registered.modelId,
    expectedCurrentId: null as string | null, reason: 'Synthetic independently verified admission boundary', evidence: {
      protocolFingerprint: f.metadata.protocolFingerprint, freezeSha256: f.evidence.freeze.sha256, reportSha256: f.evidence.report.sha256 } } };
}
it('promotes once, returns exact retry and exposes a model-only readiness gate', async () => {
  const a = await model(), first = await registry.transition(a.request), repeat = await registry.transition(a.request);
  expect(repeat).toMatchObject({ status: 'already_recorded', eventId: first.eventId, activeModelId: a.id });
  expect(await new PredictionModelRegistry(database.db).readiness()).toMatchObject({ status: 'model_eligible', modelId: a.id, teamAWinProbability: null });
  expect(await new RetestModelRegistry(database.db).verify(a.id)).toMatchObject({ status: 'verified_active', isActive: true });
  await expect(registry.transition({ ...a.request, reason: 'Changed retry payload must be rejected' })).rejects.toThrow('request_conflict');
});
it('serializes competing promotions and never loses the active champion', async () => {
  const a = await model(), b = await model();
  const result = await Promise.allSettled([registry.transition(a.request), registry.transition(b.request)]);
  expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(result.filter(r => r.status === 'rejected')).toHaveLength(1);
  expect((await sql`SELECT id FROM prediction_model_versions WHERE is_active`.execute(database.db)).rows).toHaveLength(1);
});
it('rolls back only to a previously activated version and keeps failed challengers inactive', async () => {
  const a = await model(), b = await model(), unseen = await model();
  await registry.transition(a.request); await registry.transition({ ...b.request, expectedCurrentId: a.id });
  await expect(registry.transition({ ...unseen.request, action: 'rollback', expectedCurrentId: b.id })).rejects.toThrow('rollback_target');
  await expect(registry.transition({ ...unseen.request, expectedCurrentId: b.id,
    evidence: { ...unseen.request.evidence, reportSha256: 'a'.repeat(64) } })).rejects.toThrow('activation_binding');
  expect(await new PredictionModelRegistry(database.db).readiness()).toMatchObject({ modelId: b.id });
  await registry.transition({ ...a.request, requestId: randomUUID(), action: 'rollback', expectedCurrentId: b.id });
  expect(await new PredictionModelRegistry(database.db).readiness()).toMatchObject({ modelId: a.id });
});
it('makes code changes unavailable, while emergency deactivation needs no replay or valid runtime', async () => {
  const a = await model(); await registry.transition(a.request);
  const actual = await code.readRetestRuntimeCode();
  vi.spyOn(code, 'readRetestRuntimeCode').mockResolvedValue({ ...actual, admission: [] });
  expect(await new PredictionModelRegistry(database.db).readiness()).toMatchObject({ status: 'unavailable', reason: 'ACTIVE_MODEL_EVIDENCE_INVALID' });
  const replayCalls = vi.mocked(verifyRetestRegistryEvidence).mock.calls.length;
  await registry.transition({ requestId: randomUUID(), action: 'deactivate', modelId: null, expectedCurrentId: a.id, evidence: null,
    reason: 'Synthetic emergency deactivation after code change' });
  expect(vi.mocked(verifyRetestRegistryEvidence).mock.calls.length).toBe(replayCalls);
  expect(await new PredictionModelRegistry(database.db).readiness()).toMatchObject({ reason: 'NO_ACTIVE_MODEL' });
});
it('rejects code that changes while the full activation replay is running', async () => {
  const a=await model(),actual=await code.readRetestRuntimeCode();
  vi.spyOn(code,'readRetestRuntimeCode').mockResolvedValueOnce(actual).mockResolvedValue({...actual,admission:[]});
  await expect(registry.transition(a.request)).rejects.toThrow('runtime_changed');
  expect((await sql`SELECT id FROM prediction_model_versions WHERE is_active`.execute(database.db)).rows).toHaveLength(0);
});
it('rejects direct activity changes, cross-stage requests and audit mutation', async () => {
  const a = await model();
  await expect(sql`UPDATE prediction_model_versions SET is_active=true WHERE id=${a.id}`.execute(database.db)).rejects.toThrow('active_audit_required');
  await expect(registry.transition({ ...a.request, stage: 'post_draft' })).rejects.toThrow();
  const event = await registry.transition(a.request);
  await expect(sql`UPDATE model_activation_events SET reason='forged' WHERE id=${event.eventId}`.execute(database.db)).rejects.toThrow();
  await expect(sql`DELETE FROM model_activation_events WHERE id=${event.eventId}`.execute(database.db)).rejects.toThrow();
  await expect(sql`UPDATE prediction_model_versions SET is_active=false WHERE id=${a.id}`.execute(database.db)).rejects.toThrow('active_audit_required');
});
it('rolls back the model switch if the event insert fails', async () => {
  const a = await model(), b = await model(); await registry.transition(a.request);
  await sql`ALTER TABLE model_activation_events ADD CONSTRAINT synthetic_event_failure CHECK (retest_request_id <> ${sql.lit(b.request.requestId)}::uuid)`.execute(database.db);
  try { await expect(registry.transition({ ...b.request, expectedCurrentId: a.id })).rejects.toThrow(); }
  finally { await sql`ALTER TABLE model_activation_events DROP CONSTRAINT synthetic_event_failure`.execute(database.db); }
  expect(await new PredictionModelRegistry(database.db).readiness()).toMatchObject({ modelId: a.id });
});
async function predictionFixture() {
  const f=runtimeFixture(), scenario=await new ScenarioRepository(database.db).save(owner,f.input);
  const source=v1Fixture(),{request:r,...rest}=source;
  const inventory=freezeV1ReleaseInventory({schemaVersion:1,format:'v1-release-inventory-v1',
    source:{...rest,request:{fromAt:r.fromAt,toAt:r.toAt,snapshotAt:r.snapshotAt,maxMaps:r.maxMaps}},
    metadata:source.candidates.map(m=>({matchId:m.matchId,leagueId:'77',radiantProviderTeamId:'11',direProviderTeamId:'22'})),
    inventoryScope:'all_local_maps_remote_completeness_unknown'});
  vi.spyOn(V1DataRepository.prototype,'exportReleaseInventory').mockResolvedValue(inventory);
  // Persistence-only double; the separate unit test checks unchanged real feature/link functions.
  vi.spyOn(computation,'computeRuntimeModelFeatures').mockReturnValue({features:null,probability:.5000000001,reasons:[]});
  return {inventory,request:{...f.request,scenarioId:scenario.id,expectedRevision:scenario.revision}};
}
it('both runtime paths store retest evidence, preserve exact retry after deactivation and reject a forged gate', async () => {
  const a=await model();await registry.transition(a.request);const f=await predictionFixture();
  const calls=vi.mocked(verifyRetestRegistryEvidence).mock.calls.length;
  for(const runtime of [new V1RuntimeRepository(database.db),new PageScheduledRuntimeRepository(database.db)]) {
    const request={...f.request,requestId:randomUUID()},result=await runtime.create(owner,request);
    expect(result.snapshot).toMatchObject({status:'done',teamAWinProbability:.5000000001,
      gate:{registryFormat:'v1-retest-registry-v1',evaluationBasis:'conditional_retrospective_unexposed_series',reportSha256:a.evidence.report.sha256}});
    expect(predictionView(result)).toMatchObject({status:'done',model:{candidateSha256:null,reportSha256:a.evidence.report.sha256}});
    const forged=JSON.stringify({...result.snapshot,gate:{...result.snapshot.gate as object,reportSha256:'0'.repeat(64)}});
    await expect(sql`INSERT INTO v1_runtime_snapshots(prediction_id,owner_user_id,request_id,request_hash,snapshot_text,snapshot_sha256)
      SELECT prediction_id,owner_user_id,request_id,request_hash,${forged},${registrySha(forged)} FROM v1_runtime_snapshots WHERE prediction_id=${result.id}`.execute(database.db)).rejects.toThrow('retest_runtime_active_gate_required');
    expect(await runtime.create(owner,request)).toEqual(result);
  }
  expect(vi.mocked(verifyRetestRegistryEvidence).mock.calls.length).toBe(calls);
  const runtime=new V1RuntimeRepository(database.db),last=await runtime.create(owner,f.request);
  await registry.transition({requestId:randomUUID(),action:'deactivate',modelId:null,expectedCurrentId:a.id,evidence:null,reason:'Synthetic deactivation preserves frozen forecast'});
  expect(await runtime.create(owner,f.request)).toEqual(last);
  expect((await runtime.create(owner,{...f.request,requestId:randomUUID()})).snapshot).toMatchObject({status:'unavailable',teamAWinProbability:null});
});
it('holds the registry lock through snapshot persistence so deactivation cannot race issuance', async () => {
  const a=await model();await registry.transition(a.request);const f=await predictionFixture();
  let reached!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{reached=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});
  vi.mocked(V1DataRepository.prototype.exportReleaseInventory).mockImplementation(async()=>{reached();await wait;return f.inventory;});
  const pending=new V1RuntimeRepository(database.db).create(owner,f.request);await entered;
  let changed=false;
  const transition=registry.transition({requestId:randomUUID(),action:'deactivate',modelId:null,expectedCurrentId:a.id,evidence:null,
    reason:'Synthetic concurrent deactivation must wait for issuance'}).then(result=>{changed=true;return result;});
  await new Promise(resolve=>setTimeout(resolve,30));expect(changed).toBe(false);release();
  expect((await pending).snapshot.status).toBe('done');expect((await transition).activeModelId).toBeNull();
});
