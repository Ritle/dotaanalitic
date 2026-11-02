import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { sql } from '../src/index.js';
import { V1ModelRegistry } from '../src/v1-registry-repository.js';
import { V1ReleaseEvaluationJournal } from '../src/v1-release-journal.js';
import { registryFixture } from './v1-registry-fixtures.js';
import { registrySha, registryHash } from '../src/v1-registry.js';
let database: Awaited<ReturnType<typeof testDatabase>>, registry: V1ModelRegistry;
// Journal verification has separate integration tests. These contract doubles exercise
// activation transactions without pretending that synthetic maps passed a real release gate.
const reports = new Map<string, Awaited<ReturnType<V1ReleaseEvaluationJournal['read']>>>();
beforeAll(async () => {
  database = await testDatabase(); registry = new V1ModelRegistry(database.db);
  vi.spyOn(V1ReleaseEvaluationJournal.prototype, 'read').mockImplementation(async (plan, revision) => {
    const result = reports.get(plan + ':' + revision); if (!result) throw Error('synthetic_journal_missing'); return result;
  });
}, 30000);
afterEach(async () => {
  const active = (await registry.list()).find(m => m.isActive);
  if (active) await registry.transition({ requestId: randomUUID(), action: 'deactivate', modelId: null,
    expectedCurrentId: active.modelId, reason: 'Synthetic test cleanup via audited deactivation', release: null });
});
afterAll(async () => { vi.restoreAllMocks(); await database?.close(); }, 30000);
async function candidate() {
  const f = registryFixture(), registered = await registry.register(f.bytes);
  const journal = f.journal, reportText = JSON.stringify(journal), reportSha = registrySha(reportText);
  const j = journal.journal;
  await sql`INSERT INTO v1_release_evaluation_journal(plan_fingerprint,plan_sha256,revision,capture_sha256,scorer_sha256,
    capture_text,report_text,report_sha256,evaluation_status,recorded_at)
    VALUES (${j.planFingerprint},${j.planSha256},1,${j.captureSha256},${j.scorerSha256},${f.captureText},${reportText},${reportSha},
      'evaluation_complete',${j.recordedAt}::timestamptz)`.execute(database.db);
  reports.set(j.planFingerprint + ':1', { artifact: journal, bytes: reportText, sha256: reportSha, captureText: f.captureText });
  return { ...f, modelId: registered.modelId, request: { ...f.request, modelId: registered.modelId } };
}
it('registers exact bytes once, stays inactive and protects stored artifact/model metadata', async () => {
  const f = registryFixture(); const first = await registry.register(f.bytes), retry = await registry.register(f.bytes);
  expect(first).toMatchObject({ status: 'registered_inactive', isActive: false });
  expect(retry).toMatchObject({ status: 'already_registered', modelId: first.modelId });
  const end = (await sql<{ test_end_at: Date }>`SELECT test_end_at FROM prediction_model_versions WHERE id=${first.modelId}`.execute(database.db)).rows[0]!.test_end_at;
  expect(end.toISOString()).toBe(f.plan.request.events.map(e => e.until).sort().at(-1));
  expect(await registry.readiness()).toMatchObject({ status: 'unavailable', reason: 'NO_ACTIVE_MODEL' });
  await expect(sql`UPDATE v1_model_artifacts SET candidate_text='{}' WHERE model_id=${first.modelId}`.execute(database.db)).rejects.toThrow();
  await expect(sql`UPDATE prediction_model_versions SET artifact_sha256=${'0'.repeat(64)} WHERE id=${first.modelId}`.execute(database.db)).rejects.toThrow();
  await expect(sql`UPDATE prediction_model_versions SET is_active=true WHERE id=${first.modelId}`.execute(database.db)).rejects.toThrow('registry_active_audit_required');
  await expect(sql`DELETE FROM v1_model_artifacts WHERE model_id=${first.modelId}`.execute(database.db)).rejects.toThrow();
  await expect(sql`TRUNCATE v1_model_artifacts`.execute(database.db)).rejects.toThrow();
});
it('atomically promotes, retries without duplicate events, rolls back only to a previous version and deactivates', async () => {
  const a = await candidate(), b = await candidate();
  const first = await registry.transition(a.request);
  expect(first).toMatchObject({ status: 'recorded', activeModelId: a.modelId });
  expect(await registry.readiness()).toMatchObject({ status: 'model_eligible', modelId: a.modelId, teamAWinProbability: null });
  const retry = await registry.transition(a.request); expect(retry.event.id).toBe(first.event.id);
  await expect(registry.transition({ ...a.request, reason: 'Changed replay reason' })).rejects.toThrow('registry_request_conflict');
  await expect(registry.transition({ ...b.request, action: 'rollback', expectedCurrentId: a.modelId })).rejects.toThrow('registry_rollback_target');
  await registry.transition({ ...b.request, expectedCurrentId: a.modelId });
  await registry.transition({ ...a.request, requestId: randomUUID(), action: 'rollback', expectedCurrentId: b.modelId });
  expect((await registry.list()).filter(m => m.isActive).map(m => m.modelId)).toEqual([a.modelId]);
  await expect(sql`DELETE FROM model_activation_events WHERE id=${first.event.id}`.execute(database.db)).rejects.toThrow();
  await expect(sql`TRUNCATE model_activation_events`.execute(database.db)).rejects.toThrow();
});
it('serializes concurrent challengers with CAS and leaves exactly one winner', async () => {
  const a = await candidate(), b = await candidate();
  const result = await Promise.allSettled([registry.transition(a.request), registry.transition(b.request)]);
  expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(result.filter(r => r.status === 'rejected')).toHaveLength(1);
  expect((await registry.list()).filter(m => m.isActive)).toHaveLength(1);
});
it('a failed audit insertion rolls back both active flags and preserves the champion', async () => {
  const a = await candidate(), b = await candidate(); await registry.transition(a.request);
  await sql`ALTER TABLE model_activation_events ADD CONSTRAINT synthetic_activation_failure CHECK (v1_request_id <> ${sql.lit(b.request.requestId)}::uuid)`.execute(database.db);
  try { await expect(registry.transition({ ...b.request, expectedCurrentId: a.modelId })).rejects.toThrow(); }
  finally { await sql`ALTER TABLE model_activation_events DROP CONSTRAINT synthetic_activation_failure`.execute(database.db); }
  expect((await registry.list()).filter(m => m.isActive).map(m => m.modelId)).toEqual([a.modelId]);
  expect((await registry.transition({ ...b.request, expectedCurrentId: a.modelId })).activeModelId).toBe(b.modelId);
});
it('refuses missing/stale evidence and current-version conflicts without affecting the champion', async () => {
  const a = await candidate(), b = await candidate(); await registry.transition(a.request);
  await expect(registry.transition(b.request)).rejects.toThrow('registry_current_changed');
  await expect(registry.transition({ ...b.request, expectedCurrentId: a.modelId,
    release: { ...b.request.release, revision: 2 } })).rejects.toThrow('registry_release_not_latest');
  expect((await registry.list()).find(m => m.isActive)?.modelId).toBe(a.modelId);
});
it('SQL rejects generic-evaluation bypass and a different candidate report, preserving inactive flags', async () => {
  const a = await candidate(), b = await candidate();
  await expect(sql`INSERT INTO model_activation_events(stage,event_type,activated_model_id,supporting_evaluation_id,actor,reason)
    VALUES ('pre_match','promote',${a.modelId},${randomUUID()},'owner','Synthetic generic bypass attempt')`.execute(database.db))
    .rejects.toThrow('registry_v1_evidence_required');
  await expect(sql`INSERT INTO model_activation_events(stage,event_type,activated_model_id,actor,reason,v1_request_id,
    v1_request_hash,v1_plan_fingerprint,v1_release_revision,v1_report_sha256)
    VALUES ('pre_match','promote',${b.modelId},'owner','Synthetic wrong candidate evidence',${randomUUID()},${'0'.repeat(64)},
      ${a.plan.fingerprint},1,${a.request.release.reportSha256})`.execute(database.db)).rejects.toThrow('registry_release_not_eligible');
  expect((await registry.list()).filter(m => m.isActive)).toHaveLength(0);
});
it('a later failed revision invalidates readiness and cannot be bypassed by selecting the old pass', async () => {
  const a = await candidate(); await registry.transition(a.request);
  const report = { ...a.journal.report, evaluation: { ...a.journal.report.evaluation, qualityDecision: 'failed' as const }, releaseGatePassed: false };
  const { fingerprint: _, ...reportBody } = report;
  const identity = { ...a.journal.journal, revision: 2, parentRevision: 1, parentReportSha256: a.request.release.reportSha256,
    reason: 'Synthetic later source correction', captureSha256: registrySha(a.captureText + '\n') };
  const body = { ...a.journal, journal: identity, report: { ...reportBody, fingerprint: registryHash(reportBody) } };
  const { fingerprint: _outer, ...outer } = body; const journal = { ...outer, fingerprint: registryHash(outer) };
  const bytes = JSON.stringify(journal), digest = registrySha(bytes);
  await sql`INSERT INTO v1_release_evaluation_journal(plan_fingerprint,plan_sha256,revision,parent_revision,parent_report_sha256,
    revision_reason,capture_sha256,scorer_sha256,capture_text,report_text,report_sha256,evaluation_status,recorded_at)
    VALUES (${identity.planFingerprint},${identity.planSha256},2,1,${identity.parentReportSha256},${identity.reason},
      ${identity.captureSha256},${identity.scorerSha256},${a.captureText + '\n'},${bytes},${digest},'evaluation_complete',${identity.recordedAt}::timestamptz)`.execute(database.db);
  reports.set(identity.planFingerprint + ':2', { artifact: journal, bytes, sha256: digest, captureText: a.captureText + '\n' });
  expect(await registry.readiness()).toMatchObject({ status: 'unavailable', reason: 'ACTIVE_MODEL_EVIDENCE_INVALID' });
  await registry.transition({ requestId: randomUUID(), action: 'deactivate', modelId: null, expectedCurrentId: a.modelId, reason: 'Synthetic invalid evidence withdrawal', release: null });
  await expect(registry.transition({ ...a.request, requestId: randomUUID() })).rejects.toThrow('registry_release_not_latest');
  await expect(registry.transition({ ...a.request, requestId: randomUUID(), release: { ...a.request.release, revision: 2, reportSha256: digest } }))
    .rejects.toThrow('registry_quality_not_passed');
});
