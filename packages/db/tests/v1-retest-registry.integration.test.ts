import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { sql } from '../src/index.js';
import { RetestModelRegistry } from '../src/v1-retest-registry-repository.js';
import { V1ModelRegistry } from '../src/v1-registry-repository.js';
import { verifyRetestRegistryEvidence } from '../src/v1-retest-registry-verifier.js';
import { retestRegistryFixture } from './v1-retest-registry-fixture.js';
vi.mock('../src/v1-retest-registry-verifier.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/v1-retest-registry-verifier.js')>(), verifyRetestRegistryEvidence: vi.fn()
}));
let database: Awaited<ReturnType<typeof testDatabase>>, registry: RetestModelRegistry;
beforeAll(async () => { database = await testDatabase(); registry = new RetestModelRegistry(database.db); });
afterAll(async () => { await database?.close(); });
afterEach(() => { vi.mocked(verifyRetestRegistryEvidence).mockReset(); });
const prepare = () => { const f = retestRegistryFixture(); vi.mocked(verifyRetestRegistryEvidence).mockResolvedValue(f.metadata); return f; };

it('atomically stores exact bytes and an inactive model; sequential and concurrent repeats preserve the same model', async () => {
  const f = prepare(), results = await Promise.all([registry.register(f.evidence), registry.register(f.evidence)]);
  expect(new Set(results.map(r => r.modelId)).size).toBe(1);
  expect(results.map(r => r.status).sort()).toEqual(['already_registered', 'registered_inactive']);
  const again = await registry.register(f.evidence); expect(again.modelId).toBe(results[0]!.modelId);
  expect(await registry.verify(again.modelId)).toMatchObject({ status: 'verified_inactive', metadata: f.metadata });
  const row = (await sql<{ capsule_text: string; report_text: string }>`SELECT capsule_text,report_text FROM v1_retest_model_artifacts WHERE model_id=${again.modelId}`.execute(database.db)).rows[0]!;
  expect(row.capsule_text).toBe(f.evidence.capsule.text); expect(row.report_text).toBe(f.evidence.report.text);
  expect((await registry.list()).find(r => r.modelId === again.modelId)?.isActive).toBe(false);
  expect(await new V1ModelRegistry(database.db).readiness()).toMatchObject({ status: 'unavailable', reason: 'NO_ACTIVE_MODEL' });
});
it('rejects a changed byte before replay and a failed replay before writes', async () => {
  const f = prepare(), count = (await registry.list()).length;
  await expect(registry.register({ ...f.evidence, capsule: { ...f.evidence.capsule, text: f.evidence.capsule.text + ' ' } })).rejects.toThrow('retest_registry_bytes');
  expect(verifyRetestRegistryEvidence).not.toHaveBeenCalled();
  vi.mocked(verifyRetestRegistryEvidence).mockRejectedValue(Error('retest_registry_quality_not_passed'));
  await expect(registry.register(f.evidence)).rejects.toThrow('quality_not_passed');
  expect((await registry.list()).length).toBe(count);
});
it('keeps the first registration when the same protocol arrives with different verified metadata', async () => {
  const f = prepare(), first = await registry.register(f.evidence);
  vi.mocked(verifyRetestRegistryEvidence).mockResolvedValue({ ...f.metadata, scoredSeries: 51 });
  await expect(registry.register(f.evidence)).rejects.toThrow('retest_registry_registration_conflict');
  expect((await registry.list()).find(r => r.modelId === first.modelId)?.isActive).toBe(false);
});
it('rejects wrong stage and future replay clocks before writing a model', async () => {
  const f = prepare(), count = (await registry.list()).length;
  vi.mocked(verifyRetestRegistryEvidence).mockResolvedValue({ ...f.metadata, stage: 'post_draft' as never });
  await expect(registry.register(f.evidence)).rejects.toThrow();
  vi.mocked(verifyRetestRegistryEvidence).mockResolvedValue({ ...f.metadata, firstScoringAt: '2999-01-01T00:00:00.000Z' });
  await expect(registry.register(f.evidence)).rejects.toThrow('time_gate');
  expect((await registry.list()).length).toBe(count);
});
it('rolls the new model back if evidence persistence fails', async () => {
  const f = prepare(); const before = (await sql<{ n: number }>`SELECT count(*)::integer n FROM prediction_model_versions`.execute(database.db)).rows[0]!.n;
  await sql`ALTER TABLE v1_retest_model_artifacts ADD CONSTRAINT synthetic_insert_failure CHECK (protocol_fingerprint <> ${sql.lit(f.metadata.protocolFingerprint)})`.execute(database.db);
  try { await expect(registry.register(f.evidence)).rejects.toThrow(); }
  finally { await sql`ALTER TABLE v1_retest_model_artifacts DROP CONSTRAINT synthetic_insert_failure`.execute(database.db); }
  expect((await sql<{ n: number }>`SELECT count(*)::integer n FROM prediction_model_versions`.execute(database.db)).rows[0]!.n).toBe(before);
});
it('prevents evidence mutation, metadata edits, direct activation and legacy activation bypass', async () => {
  const f = prepare(), { modelId } = await registry.register(f.evidence);
  await expect(sql`UPDATE v1_retest_model_artifacts SET report_text=report_text||' ' WHERE model_id=${modelId}`.execute(database.db)).rejects.toThrow();
  await expect(sql`DELETE FROM v1_retest_model_artifacts WHERE model_id=${modelId}`.execute(database.db)).rejects.toThrow();
  await expect(sql`TRUNCATE v1_retest_model_artifacts`.execute(database.db)).rejects.toThrow();
  await expect(sql`UPDATE prediction_model_versions SET is_active=true WHERE id=${modelId}`.execute(database.db)).rejects.toThrow('activation_pending');
  await expect(sql`UPDATE prediction_model_versions SET stage='post_draft' WHERE id=${modelId}`.execute(database.db)).rejects.toThrow();
  await expect(sql`INSERT INTO model_activation_events(stage,event_type,activated_model_id,supporting_evaluation_id,actor,reason)
    VALUES ('pre_match','promote',${modelId},${randomUUID()},'owner','Synthetic bypass must fail')`.execute(database.db)).rejects.toThrow('activation_pending');
  await expect(new V1ModelRegistry(database.db).transition({ requestId: randomUUID(), action: 'promote', modelId,
    expectedCurrentId: null, reason: 'Synthetic legacy bypass must fail', release: { planFingerprint: f.metadata.protocolFingerprint, revision: 1, reportSha256: f.evidence.report.sha256 } })).rejects.toThrow('registry_model_missing');
});
