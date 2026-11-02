import { beforeAll, afterAll, expect, it } from 'vitest';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { sql } from '../src/index.js';
import { ResearchEvaluationJournal } from '../src/research-journal.js';
import { researchJournalFixture, journalSha, sealJournal } from './research-journal-fixtures.js';
let database: Awaited<ReturnType<typeof testDatabase>>, journal: ResearchEvaluationJournal;
beforeAll(async () => { database = await testDatabase(); journal = new ResearchEvaluationJournal(database.db); }, 30000);
afterAll(async () => { await database?.close(); }, 30000);

it('commits the first result once and recovers exact report and capture bytes without scoring again', async () => {
  const f = researchJournalFixture('first'), first = await journal.evaluate(f.request, f.score);
  expect(first).toMatchObject({ status: 'recorded', artifact: { journal: { revision: 1, parentRevision: null }, report: { deployable: false } } });
  const retry = await journal.evaluate(f.request, () => { throw Error('must_not_score'); });
  expect(retry.status).toBe('already_recorded'); expect(retry.bytes).toBe(first.bytes);
  const recovered = await journal.read(f.request.planFingerprint, 1);
  expect(recovered.bytes).toBe(first.bytes); expect(recovered.captureText).toBe(f.request.captureText);
  expect(journalSha(recovered.bytes)).toBe(first.sha256); expect(await journal.list(f.request.planFingerprint)).toHaveLength(1);
});

it('serializes concurrent first attempts and only invokes one scorer', async () => {
  const f = researchJournalFixture('concurrent'); let calls = 0, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), unblock = new Promise<void>(resolve => { release = resolve; });
  const first = journal.evaluate(f.request, async () => { calls++; entered(); await unblock; return f.score(); });
  await started;
  const second = journal.evaluate(f.request, () => { calls++; return f.score(); });
  release(); const results = await Promise.all([first, second]);
  expect(calls).toBe(1); expect(results.map(r => r.status).sort()).toEqual(['already_recorded', 'recorded']);
  expect(results[0]!.bytes).toBe(results[1]!.bytes);
});

it('requires explicit changed-input/code revisions, compare-and-swap parent and stable reason on retry', async () => {
  const f = researchJournalFixture('revision'), first = await journal.evaluate(f.request, f.score);
  const changed = { ...f.request, scorerCode: [{ path: 'synthetic-challenger.js', sha256: 'b'.repeat(64) }] };
  await expect(journal.evaluate(changed, () => f.score(changed.scorerCode))).rejects.toThrow('journal_revision_required');
  const revision = { parentRevision: 1, parentReportSha256: first.sha256, reason: 'Исправление синтетического evaluator' };
  const second = await journal.evaluate({ ...changed, revision }, () => f.score(changed.scorerCode));
  expect(second.artifact.journal).toMatchObject({ revision: 2, parentRevision: 1, parentReportSha256: first.sha256 });
  expect((await journal.read(f.request.planFingerprint, 1)).bytes).toBe(first.bytes);
  expect((await journal.evaluate({ ...changed, revision }, () => { throw Error('must_not_score'); })).bytes).toBe(second.bytes);
  await expect(journal.evaluate({ ...changed, revision: { ...revision, reason: 'Другая причина повторной записи' } }, f.score)).rejects.toThrow('journal_revision_conflict');
  const text = f.request.captureText + '\n';
  await expect(journal.evaluate({ ...f.request, captureText: text, captureSha256: journalSha(text), revision }, f.score)).rejects.toThrow('journal_parent_changed');
  expect((await journal.evaluate(f.request, () => { throw Error('must_not_score'); })).bytes).toBe(first.bytes);
});

it('allows only one concurrent child of a parent and does not calculate a stale branch', async () => {
  const f = researchJournalFixture('fork'), first = await journal.evaluate(f.request, f.score); let calls = 0;
  const revision = { parentRevision: 1, parentReportSha256: first.sha256, reason: 'Synthetic concurrent correction' };
  const requests = ['\n', '\n\n'].map(suffix => ({ ...f.request, captureText: f.request.captureText + suffix,
    captureSha256: journalSha(f.request.captureText + suffix), revision }));
  const results = await Promise.allSettled(requests.map(r => journal.evaluate(r, () => { calls++; return f.score(); })));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1); expect(calls).toBe(1);
  expect(await journal.list(f.request.planFingerprint)).toHaveLength(2);
});

it('rolls back technical failure or invalid scorer output without reserving a successful first result', async () => {
  const f = researchJournalFixture('rollback');
  await expect(journal.evaluate(f.request, () => { throw Error('synthetic_crash'); })).rejects.toThrow('synthetic_crash');
  expect(await journal.list(f.request.planFingerprint)).toEqual([]);
  await expect(journal.evaluate(f.request, () => ({ ...f.score(), fingerprint: 'a'.repeat(64) }))).rejects.toThrow('journal_report_binding');
  expect(await journal.list(f.request.planFingerprint)).toEqual([]);
  expect((await journal.evaluate(f.request, f.score)).artifact.journal.revision).toBe(1);
});

it('records unavailable as the first result, never replacing it with a later usable result', async () => {
  const f = researchJournalFixture('unavailable');
  const unavailable = sealJournal({ ...f.score(), evaluation: { ...f.report.evaluation, status: 'unavailable' as const, metrics: null } });
  const first = await journal.evaluate(f.request, () => unavailable);
  expect(first.artifact.report.evaluation.status).toBe('unavailable');
  expect((await journal.evaluate(f.request, f.score)).bytes).toBe(first.bytes);
});

it('does not return a computed result when database persistence fails and releases the transaction for a safe retry', async () => {
  const f = researchJournalFixture('database-failure'); let calls = 0;
  await sql`ALTER TABLE research_evaluation_journal ADD CONSTRAINT synthetic_insert_failure CHECK (plan_fingerprint <> ${sql.lit(f.request.planFingerprint)})`.execute(database.db);
  try {
    await expect(journal.evaluate(f.request, () => { calls++; return f.score(); })).rejects.toThrow();
    expect(calls).toBe(1); expect(await journal.list(f.request.planFingerprint)).toEqual([]);
  } finally { await sql`ALTER TABLE research_evaluation_journal DROP CONSTRAINT synthetic_insert_failure`.execute(database.db); }
  expect((await journal.evaluate(f.request, f.score)).artifact.journal.revision).toBe(1);
});

it('rejects malformed capture hashes, missing parents, alternate plan SHA and database-clock future captures', async () => {
  const f = researchJournalFixture('guards');
  await expect(journal.evaluate({ ...f.request, captureSha256: '0'.repeat(64) }, f.score)).rejects.toThrow('journal_capture_hash_mismatch');
  await expect(journal.evaluate({ ...f.request, revision: { parentRevision: 1, parentReportSha256: '0'.repeat(64), reason: 'Synthetic orphan revision' } }, f.score)).rejects.toThrow('journal_parent_missing');
  await journal.evaluate(f.request, f.score);
  await expect(journal.evaluate({ ...f.request, planSha256: 'f'.repeat(64) }, f.score)).rejects.toThrow('journal_plan_sha_changed');
  const capture = structuredClone(f.capture);
  capture.execution.snapshot.request.snapshotAt = '2999-01-01T00:00:00.000Z';
  capture.execution.snapshot = sealJournal(capture.execution.snapshot);
  capture.execution.capturedAt = '2999-01-01T00:00:00.000Z'; capture.execution = sealJournal(capture.execution);
  const text = JSON.stringify(sealJournal(capture));
  await expect(journal.evaluate({ ...f.request, captureText: text, captureSha256: journalSha(text) }, f.score)).rejects.toThrow('journal_time_gate');
});

it('database triggers prohibit update, delete and truncate while preserving original export', async () => {
  const f = researchJournalFixture('immutable'), first = await journal.evaluate(f.request, f.score);
  await expect(sql`UPDATE research_evaluation_journal SET revision_reason='tampering' WHERE plan_fingerprint=${f.request.planFingerprint}`.execute(database.db)).rejects.toThrow();
  await expect(sql`DELETE FROM research_evaluation_journal WHERE plan_fingerprint=${f.request.planFingerprint}`.execute(database.db)).rejects.toThrow();
  await expect(sql`TRUNCATE research_evaluation_journal`.execute(database.db)).rejects.toThrow();
  expect((await journal.read(f.request.planFingerprint, 1)).bytes).toBe(first.bytes);
});
