import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { sql } from '../src/index.js';
import { ScenarioRepository } from '../src/scenario-repository.js';
import { V1RuntimeRepository } from '../src/v1-runtime-repository.js';
import { V1ModelRegistry } from '../src/v1-registry-repository.js';
import { V1ReleaseEvaluationJournal } from '../src/v1-release-journal.js';
import { V1DataRepository } from '../src/v1-data-repository.js';
import * as computation from '../src/v1-runtime.js';
import * as compatibility from '../src/v1-runtime-code.js';
import { freezeV1ReleaseInventory } from '../src/v1-release-inventory.js';
import { registrySha } from '../src/v1-registry.js';
import { runtimeFixture } from './v1-runtime-fixtures.js';
import { registryFixture } from './v1-registry-fixtures.js';
import { v1Fixture } from './v1-data-fixtures.js';
let database: Awaited<ReturnType<typeof testDatabase>>, repo: V1RuntimeRepository, owner: string;
beforeAll(async () => {
  database = await testDatabase(); repo = new V1RuntimeRepository(database.db);
  owner = (await sql<{ id: string }>`INSERT INTO app_users(login,password_hash) VALUES ('synthetic-runtime',${'x'.repeat(40)}) RETURNING id`.execute(database.db)).rows[0]!.id;
  await sql`INSERT INTO teams(id,name) VALUES (11,'Synthetic A'),(22,'Synthetic B')`.execute(database.db);
  await sql`INSERT INTO leagues(id,opendota_league_id,name) VALUES (77,77,'Synthetic scope')`.execute(database.db);
  for (let i = 101; i <= 110; i++) await sql`INSERT INTO players(id,nickname) VALUES (${String(i)},'Synthetic player')`.execute(database.db);
}, 30000);
afterEach(async () => {
  const registry = new V1ModelRegistry(database.db), active = (await registry.list()).find(m => m.isActive);
  if (active) await registry.transition({ requestId: randomUUID(), action: 'deactivate', modelId: null, expectedCurrentId: active.modelId,
    reason: 'Synthetic runtime contract cleanup', release: null });
  vi.restoreAllMocks();
});
afterAll(async () => { await database?.close(); }, 30000);
async function scenario() {
  const f = runtimeFixture(), s = await new ScenarioRepository(database.db).save(owner, f.input);
  return { ...f, scenario: s, request: { ...f.request, scenarioId: s.id, expectedRevision: s.revision } };
}
async function positiveContract() {
  // Explicit protocol doubles, never evidence that real maps passed a quality gate.
  const f = registryFixture(), registry = new V1ModelRegistry(database.db), model = await registry.register(f.bytes);
  const j = f.journal.journal, reportText = JSON.stringify(f.journal), reportSha = registrySha(reportText);
  await sql`INSERT INTO v1_release_evaluation_journal(plan_fingerprint,plan_sha256,revision,capture_sha256,scorer_sha256,
    capture_text,report_text,report_sha256,evaluation_status,recorded_at)
    VALUES (${j.planFingerprint},${j.planSha256},1,${j.captureSha256},${j.scorerSha256},${f.captureText},${reportText},${reportSha},
      'evaluation_complete',${j.recordedAt}::timestamptz)`.execute(database.db);
  vi.spyOn(V1ReleaseEvaluationJournal.prototype, 'read').mockResolvedValue({ artifact: f.journal, bytes: reportText,
    sha256: reportSha, captureText: f.captureText });
  await registry.transition({ ...f.request, modelId: model.modelId });
  const source = v1Fixture(), { request: r, ...rest } = source;
  const inventory = freezeV1ReleaseInventory({ schemaVersion: 1, format: 'v1-release-inventory-v1',
    source: { ...rest, request: { fromAt: r.fromAt, toAt: r.toAt, snapshotAt: r.snapshotAt, maxMaps: r.maxMaps } },
    metadata: source.candidates.map(m => ({ matchId: m.matchId, leagueId: '77', radiantProviderTeamId: '11', direProviderTeamId: '22' })),
    inventoryScope: 'all_local_maps_remote_completeness_unknown' });
  vi.spyOn(V1DataRepository.prototype, 'exportReleaseInventory').mockResolvedValue(inventory);
  vi.spyOn(compatibility, 'compatibleV1Runtime').mockReturnValue(true);
  vi.spyOn(computation, 'computeV1RuntimeFeatures').mockReturnValue({ features: null, probability: 0.5000000001, reasons: [] });
  return { registry, model, inventory };
}
it('persists unavailable with null probability, exact retry and immutable source/scenario snapshot', async () => {
  const f = await scenario(), result = await repo.create(owner, f.request);
  expect(result.snapshot).toMatchObject({ status: 'unavailable', teamAWinProbability: null, issuedAt: null });
  expect(result.snapshot.reasons).toContain('NO_ACTIVE_MODEL');
  expect(result.snapshot.reasons).toContain('CURRENT_IDENTITIES_UNVERIFIED');
  expect(result.snapshot.source).not.toBeNull();
  expect(await repo.create(owner, f.request)).toEqual(result);
  expect(await repo.get(randomUUID(), f.request.requestId)).toBeNull();
  await new ScenarioRepository(database.db).save(owner, { ...f.input, title: 'Synthetic edited scenario' }, { id: f.scenario.id, expectedRevision: 1 });
  expect(await repo.create(owner, f.request)).toEqual(result);
  await expect(repo.create(owner, { ...f.request, expectedRevision: 2 })).rejects.toThrow('runtime_request_conflict');
  await expect(sql`UPDATE prediction_runs SET warnings='[]'::jsonb WHERE id=${result.id}`.execute(database.db)).rejects.toThrow();
  await expect(sql`DELETE FROM prediction_runs WHERE id=${result.id}`.execute(database.db)).rejects.toThrow();
  await expect(sql`DELETE FROM scenarios WHERE id=${f.scenario.id}`.execute(database.db)).rejects.toThrow();
  await expect(sql`UPDATE v1_runtime_snapshots SET snapshot_text='{}' WHERE prediction_id=${result.id}`.execute(database.db)).rejects.toThrow();
  await expect(sql`TRUNCATE prediction_runs CASCADE`.execute(database.db)).rejects.toThrow();
});
it('serializes duplicate requests and rejects another owner or stale scenario revision before writing', async () => {
  const f = await scenario();
  const results = await Promise.all([repo.create(owner, f.request), repo.create(owner, f.request)]);
  expect(results[0]).toEqual(results[1]);
  await expect(repo.create(randomUUID(), { ...f.request, requestId: randomUUID() })).rejects.toThrow('NOT_FOUND');
  await expect(repo.create(owner, { ...f.request, requestId: randomUUID(), expectedRevision: 9 })).rejects.toThrow('CONFLICT');
});
it('bounded history failure is an explicit attempt, without partial data or probability', async () => {
  const f = await scenario();
  vi.spyOn(V1DataRepository.prototype, 'exportReleaseInventory').mockRejectedValue(Error('v1_inventory_limit'));
  const result = await repo.create(owner, f.request);
  expect(result.snapshot.reasons).toContain('HISTORY_INVENTORY_LIMIT');
  expect(result.snapshot.source).toBeNull(); expect(result.snapshot.teamAWinProbability).toBeNull();
});
it('positive contract persists before returning, retains probability precision and activation evidence', async () => {
  const f = await scenario(), c = await positiveContract(), result = await repo.create(owner, f.request);
  expect(result.snapshot.status).toBe('done');
  expect(result.snapshot.teamAWinProbability).toBe(0.5000000001);
  expect(result.snapshot.issuedAt! >= result.snapshot.createdAt).toBe(true);
  expect(result.snapshot.gate).toMatchObject({ modelId: c.model.modelId, status: 'model_eligible', releaseRevision: 1 });
  const probability = (await sql<{ p: string }>`SELECT team_a_win_probability::text AS p FROM prediction_runs WHERE id=${result.id}`.execute(database.db)).rows[0]!.p;
  expect(Number(probability)).toBe(0.5000000001);
  expect(await repo.get(owner, f.request.requestId)).toEqual(result);
});
it('refuses incompatible execution and missing tier scope even with an active positive gate double', async () => {
  const f = await scenario(); await positiveContract();
  vi.mocked(compatibility.compatibleV1Runtime).mockReturnValue(false);
  const result = await repo.create(owner, { ...f.request, targetScope: null });
  expect(result.snapshot.reasons).toEqual(expect.arrayContaining(['INFERENCE_CODE_MISMATCH', 'TIER1_SCOPE_NOT_REVIEWED']));
  expect(result.snapshot.teamAWinProbability).toBeNull();
});
it('a failed terminal insert rolls back the prediction and retry is safe', async () => {
  const f = await scenario(); await positiveContract();
  await sql`ALTER TABLE v1_runtime_snapshots ADD CONSTRAINT synthetic_runtime_failure CHECK (request_id<>${sql.lit(f.request.requestId)}::uuid)`.execute(database.db);
  try { await expect(repo.create(owner, f.request)).rejects.toThrow(); }
  finally { await sql`ALTER TABLE v1_runtime_snapshots DROP CONSTRAINT synthetic_runtime_failure`.execute(database.db); }
  expect((await sql`SELECT 1 FROM prediction_runs WHERE v1_request_id=${f.request.requestId}`.execute(database.db)).rows).toHaveLength(0);
  expect((await repo.create(owner, f.request)).snapshot.status).toBe('done');
});
it('holds activation locks through computation and releases only after persistence', async () => {
  const f = await scenario(), c = await positiveContract();
  const original = vi.mocked(V1DataRepository.prototype.exportReleaseInventory);
  let unblock!: () => void, entered!: () => void;
  const wait = new Promise<void>(resolve => { unblock = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  original.mockImplementationOnce(async () => { entered(); await wait; return c.inventory; });
  const running = repo.create(owner, f.request); await started;
  let finished = false;
  const deactivation = c.registry.transition({ requestId: randomUUID(), action: 'deactivate', modelId: null,
    expectedCurrentId: c.model.modelId, reason: 'Synthetic concurrent deactivation', release: null }).then(r => { finished = true; return r; });
  await new Promise(resolve => setTimeout(resolve, 50)); expect(finished).toBe(false);
  unblock(); expect((await running).snapshot.status).toBe('done'); await deactivation;
  expect((await repo.create(owner, { ...f.request, requestId: randomUUID() })).snapshot.reasons).toContain('NO_ACTIVE_MODEL');
});
it('records unavailable when the target starts during computation, without an issued probability', async () => {
  const c = await positiveContract(), f = runtimeFixture();
  const scheduledAt = new Date(Date.now() + 1500).toISOString();
  const s = await new ScenarioRepository(database.db).save(owner, { ...f.input, cutoffAt: scheduledAt, scheduledAt });
  vi.mocked(V1DataRepository.prototype.exportReleaseInventory).mockImplementationOnce(async () => {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(scheduledAt) - Date.now() + 10)));
    return c.inventory;
  });
  const result = await repo.create(owner, { ...f.request, scenarioId: s.id,
    targetScope: { ...f.request.targetScope!, fromAt: '2020-01-01T00:00:00.000Z' } });
  expect(result.snapshot.reasons).toContain('TARGET_ALREADY_STARTED');
  expect(result.snapshot).toMatchObject({ status: 'unavailable', issuedAt: null, teamAWinProbability: null });
});
