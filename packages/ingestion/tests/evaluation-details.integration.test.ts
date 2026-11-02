import { beforeAll, afterAll, expect, it } from 'vitest';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { sql, IdentityRepository, V1DataRepository } from '../../db/src/index.js';
import { IngestionService } from '../src/importer.js';
import { validateEvaluationDetails, reconcileEvaluationCandidates } from '../src/evaluation-details.js';
import { detailsFixture, detailTime } from './evaluation-details-fixtures.js';
let database: Awaited<ReturnType<typeof testDatabase>>;
const f = detailsFixture(), captured = validateEvaluationDetails(f.ledger, f.entries, 0, detailTime, detailTime);
beforeAll(async () => {
  database = await testDatabase();
  await sql`INSERT INTO teams(id,name,opendota_team_id) VALUES(11,'Synthetic A',111),(22,'Synthetic B',222)`.execute(database.db);
  await sql`INSERT INTO series(team_a_id,team_b_id,provider,provider_series_id) VALUES(11,22,'opendota','1')`.execute(database.db);
  for (let i = 0; i < 10; i++) {
    await sql`INSERT INTO players(id,nickname) VALUES(${String(101 + i)},'Synthetic evaluation player')`.execute(database.db);
    await new IdentityRepository(database.db).appendAccountEvidence({ playerId: String(101 + i), provider: 'opendota', externalAccountId: String(10001 + i),
      status: 'verified', eventAt: null, knownAt: '2026-10-30T00:00:00.000Z', fetchedAt: '2026-10-30T00:00:00.000Z', source: 'synthetic-detail-proof', evidenceRef: 'synthetic:detail' });
  }
}, 30000);
afterAll(async () => { await database?.close(); }, 30000);
async function snapshot() {
  return new V1DataRepository(database.db, true).export({ ...f.source.request, toAt: new Date().toISOString(), snapshotAt: new Date().toISOString() }, f.source.code);
}
it('keeps the missing target in coverage before import, then verifies the captured source through canonical outcome/identity/series checks', async () => {
  expect(reconcileEvaluationCandidates(f.ledger, await snapshot(), captured.report).coverage).toMatchObject({ observedTargetMaps: 1, dataReadyMaps: 0, mapCoverage: 0 });
  expect(await new IngestionService(database.db, captured.provider).ingest('1')).toMatchObject({ matchId: '1', status: 'accepted', duplicate: false });
  const dataset = await snapshot(), report = reconcileEvaluationCandidates(f.ledger, dataset, captured.report);
  expect(report.coverage).toMatchObject({ observedTargetMaps: 1, dataReadyMaps: 1, targetMapsWithVerifiedOutcomes: 1, knownSeriesCoverage: 1 });
  expect(report).toMatchObject({ metrics: null, deployable: false, trainingReady: false });
  expect(dataset.source.candidates[0]!.facts.some(fact => fact.knownAtUs === null)).toBe(true);
});
it('replays the stored source idempotently with no additional provider call, row or data revision', async () => {
  const before = await snapshot();
  expect(await new IngestionService(database.db, captured.provider).ingest('1')).toMatchObject({ duplicate: true });
  const after = await snapshot();
  expect(after.source.candidates).toEqual(before.source.candidates.map(m => ({ ...m, outcome: m.outcome.status === 'verified' ?
    { ...m.outcome, labelVerifiedAt: after.source.request.snapshotAt } : m.outcome })));
  expect((await sql`SELECT (SELECT count(*)::int FROM matches) maps,(SELECT count(*)::int FROM match_players) slots,
    (SELECT count(*)::int FROM training_dataset_versions) datasets,(SELECT count(*)::int FROM prediction_model_versions) models`.execute(database.db)).rows[0])
    .toEqual({ maps: 1, slots: 10, datasets: 0, models: 0 });
});
it('retains an imported map with a conflicting canonical winner in the denominator and preserves old snapshots', async () => {
  const original = await snapshot(), frozen = JSON.stringify(original);
  await sql`UPDATE matches SET radiant_win=NOT radiant_win WHERE id=1`.execute(database.db);
  try {
    const report = reconcileEvaluationCandidates(f.ledger, await snapshot(), captured.report);
    expect(report.coverage).toMatchObject({ observedTargetMaps: 1, dataReadyMaps: 0, mapCoverage: 0, targetMapsWithVerifiedOutcomes: 0 });
    expect(report.assessments[0]!.reasons).toContain('CANONICAL_OUTCOME_UNVERIFIED');
    expect(JSON.stringify(original)).toBe(frozen);
  } finally { await sql`UPDATE matches SET radiant_win=NOT radiant_win WHERE id=1`.execute(database.db); }
});
