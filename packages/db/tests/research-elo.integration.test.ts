import { beforeAll, afterAll, expect, it } from 'vitest';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { sql, IdentityRepository } from '../src/index.js';
import { ResearchEloRepository } from '../src/research-elo-repository.js';
import { evaluateResearchElo, evaluateResearchEloWithExclusions, freezeResearchElo } from '../src/research-elo.js';
import { planResearchElo } from '../src/research-plan.js';
import { researchExecutionRequest, freezeResearchExecution, evaluateResearchExecution } from '../src/research-execution.js';
import { planFixture, digest } from './research-plan-fixtures.js';
import { OpenDotaClient, IngestionService } from '../../ingestion/src/index.js';
import { researchFixture, date, sourceTime } from './research-elo-fixtures.js';
let database: Awaited<ReturnType<typeof testDatabase>>;
const request = researchFixture().request, code = researchFixture().code;
const read = () => new ResearchEloRepository(database.db, true).export(request, code);
beforeAll(async () => {
  database = await testDatabase();
  await sql`INSERT INTO teams(id,name,opendota_team_id) VALUES (11,'Synthetic A',111),(22,'Synthetic B',222)`.execute(database.db);
  const identity = new IdentityRepository(database.db);
  for (let i = 0; i < 10; i++) {
    await sql`INSERT INTO players(id,nickname) VALUES (${String(i + 101)},'Synthetic research player')`.execute(database.db);
    await identity.appendAccountEvidence({ playerId: String(i + 101), externalAccountId: String(i + 10001), provider: 'opendota',
      status: 'verified', eventAt: null, knownAt: sourceTime, fetchedAt: sourceTime, source: 'synthetic-only', evidenceRef: 'synthetic:e0' });
  }
  for (let n = 1; n <= 6; n++) {
    const series = (await sql<{ id: string }>`INSERT INTO series(team_a_id,team_b_id,provider,provider_series_id)
      VALUES (11,22,'opendota',${String(n)}) RETURNING id`.execute(database.db)).rows[0]!.id;
    const payload = { match_id: String(9007199254760000n + BigInt(n)), start_time: Date.parse(date(n)) / 1000,
      duration: 1800, radiant_win: n % 3 !== 2, radiant_team_id: 111, dire_team_id: 222, leagueid: 77, series_id: n,
      players: Array.from({ length: 10 }, (_, i) => ({ player_slot: i < 5 ? i : i + 123, hero_id: i + 1, account_id: i + 10001 })) };
    let clock = Date.parse(sourceTime);
    const client = new OpenDotaClient({}, { now: () => clock, sleep: async ms => { clock += ms; }, fetch: async url => new Response(JSON.stringify(
      url.pathname === '/api/heroes' ? Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `synthetic_${i}`, localized_name: `Synthetic ${i}` })) :
        url.pathname === '/api/leagues' ? [{ leagueid: 77, name: 'Synthetic league', tier: 'professional' }] : payload)) });
    await new IngestionService(database.db, client).ingest(payload.match_id);
    await sql`UPDATE matches SET series_id=${series},data_revision=data_revision+1 WHERE id=${payload.match_id}`.execute(database.db);
  }
}, 30000);
afterAll(async () => { await database?.close(); }, 30000);
async function counts() {
  return (await sql`SELECT (SELECT count(*) FROM matches) AS maps,(SELECT count(*) FROM match_field_observations) AS facts,
    (SELECT count(*) FROM provider_ingest_receipts) AS receipts,(SELECT count(*) FROM training_dataset_versions) AS datasets,
    (SELECT count(*) FROM prediction_model_versions) AS models,(SELECT revision FROM identity_registry_state WHERE singleton) AS identity_revision`.execute(database.db)).rows;
}
it('uses verified source outcomes/current numeric identities, preserves unknown clocks and performs no dataset/model writes', async () => {
  const before = await counts(), frozen = await read(), report = evaluateResearchElo(frozen);
  expect(report).toMatchObject({ status: 'research_complete', syntheticOnly: true, summary: { eligibleMaps: 6, warmupMaps: 3, scoredMaps: 3 } });
  expect(frozen.candidates.every(m => m.outcome.status === 'verified' && m.seriesSourceMatched)).toBe(true);
  expect(frozen.candidates.flatMap(m => m.facts).some(f => f.knownAtUs === null)).toBe(true);
  expect(frozen.identities.every(p => p.knownAt === sourceTime)).toBe(true);
  expect((await read()).fingerprint).toBe(frozen.fingerprint);
  expect(await counts()).toEqual(before);
});
it('source/canonical outcome disagreement excludes the map without rewriting a prior frozen export', async () => {
  const frozen = await read(), previous = JSON.stringify(frozen), id = frozen.candidates[0]!.matchId;
  await sql`UPDATE matches SET radiant_win=NOT radiant_win WHERE id=${id}`.execute(database.db);
  try {
    const changed = await read();
    expect(evaluateResearchElo(changed).assessments.find(row => row.matchId === id)!.reasons).toContain('OUTCOME_NO_MATCHING_VERIFIED_RECEIPT_AT_SNAPSHOT');
    expect(JSON.stringify(frozen)).toBe(previous);
  } finally { await sql`UPDATE matches SET radiant_win=NOT radiant_win WHERE id=${id}`.execute(database.db); }
});
it('canonical slot corruption cannot pass just because the outcome is verified', async () => {
  const id = '9007199254760001';
  await sql`UPDATE match_players SET source_account_id='10002' WHERE match_id=${id} AND player_slot=0`.execute(database.db);
  try { expect(evaluateResearchElo(await read()).assessments.find(row => row.matchId === id)!.reasons).toContain('ROSTER_RECEIPT_MISMATCH'); }
  finally { await sql`UPDATE match_players SET source_account_id='10001' WHERE match_id=${id} AND player_slot=0`.execute(database.db); }
});
it('rejects truncation and future snapshot requests', async () => {
  const reader = new ResearchEloRepository(database.db, true);
  await expect(reader.export({ ...request, maxMaps: 1 }, code)).rejects.toThrow('research_inventory_limit');
  await expect(reader.export({ ...request, snapshotAt: '2999-01-01T00:00:00.000Z' }, code)).rejects.toThrow('research_snapshot_in_future');
});
it('applies source exclusions to a verified PG snapshot without rewriting labels, original evaluation or database state', async () => {
  const before = await counts(), frozen = await read(), original = evaluateResearchElo(frozen), bytes = JSON.stringify(frozen);
  const target = original.assessments.find(r => r.split === 'holdout')!;
  const restricted = evaluateResearchEloWithExclusions(frozen, [{ matchId: target.matchId, reasons: ['EVIDENCE_DETAIL_MISSING'] }]);
  expect(restricted.summary.scoredMaps).toBe(original.summary.scoredMaps - 1);
  expect(restricted.assessments.find(r => r.matchId === target.matchId)?.reasons).toContain('EVIDENCE_DETAIL_MISSING');
  expect(JSON.stringify(frozen)).toBe(bytes); expect(evaluateResearchElo(frozen)).toEqual(original);
  expect((await read()).fingerprint).toBe(frozen.fingerprint); expect(await counts()).toEqual(before);
});
it('an earlier snapshot cannot consume late imports even under the explicitly reconstructed research cohort', async () => {
  const result = await new ResearchEloRepository(database.db, true).export({ ...request, snapshotAt: '2025-01-01T00:00:00.000Z' }, code);
  expect(evaluateResearchElo(result)).toMatchObject({ status: 'unavailable', metrics: null, summary: { eligibleMaps: 0 } });
});

it('captures the full PostgreSQL inventory under a synthetic preregistered plan and scores without writes', async () => {
  const fixture = researchFixture();
  const prior = freezeResearchElo({ ...fixture, candidates: [], aliases: [], identities: [],
    request: { ...fixture.request, fromAt: '2020-01-01T00:00:00.000Z', holdoutFromAt: '2021-01-01T00:00:00.000Z',
      toAt: '2022-01-01T00:00:00.000Z', snapshotAt: '2023-01-01T00:00:00.000Z' } });
  const sources = planFixture(), observedAt = '2024-01-03T22:00:00.000Z';
  sources.discovery.selection_catalog.source_evidence.fetched_at = observedAt;
  const cohort = sources.discovery.cohorts[0]!; cohort.source_evidence.fetched_at = observedAt;
  cohort.matches = [1, 2, 3].map(n => ({ match_id: String(9007199254760000n + BigInt(n)),
    start_time: Date.parse(date(n)) / 1000, leagueid: '77', series_id: String(n),
    radiant_team_id: '111', dire_team_id: '222', radiant_win: true }));
  const plan = planResearchElo({ ...sources.request, holdoutFromAt: request.holdoutFromAt, holdoutUntil: request.toAt,
    evaluationNotBefore: request.snapshotAt, priorExportSha256: digest(JSON.stringify(prior)),
    discoverySha256: digest(JSON.stringify(sources.discovery)) }, prior, sources.discovery, '2024-01-03T23:00:00.000Z');
  const before = await counts();
  const snapshot = await new ResearchEloRepository(database.db, true).export(researchExecutionRequest(plan), code);
  const capture = freezeResearchExecution(plan, snapshot, request.snapshotAt, code);
  const report = evaluateResearchExecution(plan, capture, request.snapshotAt);
  expect(report).toMatchObject({ deployable: false, releaseGate: 'not_assessed', evaluation: {
    status: 'research_complete', summary: { candidateMaps: 6, warmupMaps: 3, scoredMaps: 3 } } });
  expect(await counts()).toEqual(before);
});
