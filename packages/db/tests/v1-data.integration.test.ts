import { beforeAll, afterAll, expect, it } from 'vitest';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { sql, IdentityRepository } from '../src/index.js';
import { V1DataRepository } from '../src/v1-data-repository.js';
import { verifyV1Data } from '../src/v1-data.js';
import { verifyV1ReleaseInventory, prepareReleaseHistory } from '../src/v1-release-inventory.js';
import { OpenDotaClient, IngestionService } from '../../ingestion/src/index.js';
import { date, sourceTime } from './research-elo-fixtures.js';
import { v1Fixture } from './v1-data-fixtures.js';
let database: Awaited<ReturnType<typeof testDatabase>>;
const request = v1Fixture().request, code = v1Fixture().code;
const read = () => new V1DataRepository(database.db, true).export(request, code);
const releaseWindow = { fromAt: request.fromAt, toAt: request.toAt, snapshotAt: request.snapshotAt, maxMaps: request.maxMaps };
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

it('exports six maps with no patch registry or pre-known roster, freezes clocks and performs no DB writes', async () => {
  const before = await counts(), first = await read(), second = await read();
  expect(first.report).toMatchObject({ status: 'prepared', summary: { eligibleMaps: 6, mapsWithAllPlayersHistory: 5 },
    trainingReady: false, deployable: false, evaluation: 'not_performed' });
  expect(first.source.candidates.flatMap(m => m.facts).some(f => f.knownAtUs === null)).toBe(true);
  expect(first.source.identities.every(i => i.knownAt === sourceTime)).toBe(true);
  expect(first).toEqual(second); expect(verifyV1Data(first)).toEqual(first);
  expect(await counts()).toEqual(before);
});
it('freezes generic release inventory with native metadata in a read-only repeatable snapshot', async () => {
  const before = await counts(), repo = new V1DataRepository(database.db, true);
  const first = await repo.exportReleaseInventory(releaseWindow, code);
  expect(first).toEqual(await repo.exportReleaseInventory(releaseWindow, code));
  expect(verifyV1ReleaseInventory(first)).toEqual(first);
  expect(first.source.request).toEqual(releaseWindow);
  expect(first.metadata).toHaveLength(6);
  expect(first.metadata.every(m => m.leagueId === '77' && m.radiantProviderTeamId === '111' && m.direProviderTeamId === '222')).toBe(true);
  expect(prepareReleaseHistory(first).history.maps).toHaveLength(6);
  expect(await counts()).toEqual(before);
});
it('enforces release inventory limits, snapshot clock and production synthetic guard', async () => {
  const repo = new V1DataRepository(database.db, true);
  await expect(repo.exportReleaseInventory({ ...releaseWindow, maxMaps: 1 }, code)).rejects.toThrow('v1_inventory_limit');
  await expect(repo.exportReleaseInventory({ ...releaseWindow, snapshotAt: '2999-01-01T00:00:00.000Z' }, code)).rejects.toThrow('v1_snapshot_in_future');
  await expect(new V1DataRepository(database.db).exportReleaseInventory(releaseWindow, code)).rejects.toThrow('v1_synthetic_evidence_forbidden');
});
it('source disagreement excludes a map and leaves its previous export intact', async () => {
  const frozen = await read(), bytes = JSON.stringify(frozen), id = frozen.source.candidates[0]!.matchId;
  await sql`UPDATE matches SET radiant_win=NOT radiant_win WHERE id=${id}`.execute(database.db);
  try {
    const changed = await read();
    expect(changed.report.assessments[0]!.reasons).toContain('OUTCOME_NO_MATCHING_VERIFIED_RECEIPT_AT_SNAPSHOT');
    expect(JSON.stringify(frozen)).toBe(bytes);
  } finally { await sql`UPDATE matches SET radiant_win=NOT radiant_win WHERE id=${id}`.execute(database.db); }
});
it('rejects canonical player corruption against the verified source receipt', async () => {
  const id = '9007199254760001';
  await sql`UPDATE match_players SET source_account_id='10002' WHERE match_id=${id} AND player_slot=0`.execute(database.db);
  try { expect((await read()).report.assessments[0]!.reasons).toContain('ROSTER_RECEIPT_MISMATCH'); }
  finally { await sql`UPDATE match_players SET source_account_id='10001' WHERE match_id=${id} AND player_slot=0`.execute(database.db); }
});
it('rejects oversized inventories and future snapshots; late imports are not known earlier', async () => {
  const repo = new V1DataRepository(database.db, true);
  await expect(repo.export({ ...request, maxMaps: 1 }, code)).rejects.toThrow('v1_inventory_limit');
  await expect(repo.export({ ...request, snapshotAt: '2999-01-01T00:00:00.000Z' }, code)).rejects.toThrow('v1_snapshot_in_future');
  const earlier = await repo.export({ ...request, snapshotAt: '2025-01-01T00:00:00.000Z' }, code);
  expect(earlier.report).toMatchObject({ status: 'unavailable', summary: { eligibleMaps: 0 } });
});
it('retains out-of-window siblings for whole-series exclusion and blocks synthetic production capture', async () => {
  const original = await read(), first = original.source.candidates[0]!, second = original.source.candidates[1]!;
  await sql`UPDATE series SET provider_series_id='1' WHERE id=${second.seriesId}`.execute(database.db);
  try {
    const result = await new V1DataRepository(database.db, true).export({ ...request, fromAt: '2024-01-02T00:00:00.000Z' }, code);
    expect(result.report.assessments.find(m => m.matchId === second.matchId)!.reasons).toContain('SERIES_OUTSIDE_WINDOW');
    expect(result.report.assessments.find(m => m.matchId === first.matchId)!.selected).toBe(false);
  } finally { await sql`UPDATE series SET provider_series_id='2' WHERE id=${second.seriesId}`.execute(database.db); }
  await expect(new V1DataRepository(database.db).export(request, code)).rejects.toThrow('v1_synthetic_evidence_forbidden');
});
