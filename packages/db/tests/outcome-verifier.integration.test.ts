import { afterAll, beforeAll, expect, it } from 'vitest';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { sql } from '../src/index.js';
import { OutcomeVerifier } from '../src/outcome-verifier.js';
import { OpenDotaClient, IngestionService } from '../../ingestion/src/index.js';

// SYNTHETIC provider responses, isolated test database. Never production evidence.
let database: Awaited<ReturnType<typeof testDatabase>>;
const snapshotAt = '2026-10-31T12:00:00.000Z';
let nextId = 9007199254742000n;
beforeAll(async () => {
  database = await testDatabase();
  await sql`INSERT INTO teams(id,name,opendota_team_id) VALUES (11,'Synthetic A',111),(22,'Synthetic B',222)`.execute(database.db);
}, 30000);
afterAll(async () => { await database?.close(); }, 30000);
async function ingest(payload: Record<string, unknown>) {
  let clock = Date.UTC(2026, 9, 30);
  const client = new OpenDotaClient({}, { now: () => clock, sleep: async ms => { clock += ms; }, fetch: async url => {
    const data = url.pathname === '/api/heroes' ? Array.from({ length: 10 }, (_, i) => ({ id: i + 1,
      name: `synthetic_${i}`, localized_name: `Synthetic ${i}` })) : url.pathname === '/api/leagues' ?
      [{ leagueid: 77, name: 'Synthetic pro league', tier: 'professional' }] : payload;
    return new Response(JSON.stringify(data));
  } });
  return new IngestionService(database.db, client).ingest(String(payload.match_id));
}
async function example() {
  const matchId = String(nextId++);
  const payload = { match_id: matchId, start_time: 1704110400, duration: 1800, radiant_win: true,
    radiant_team_id: 111, dire_team_id: 222, leagueid: 77, series_id: 0,
    players: Array.from({ length: 10 }, (_, i) => ({ player_slot: i < 5 ? i : i + 123, hero_id: i + 1, account_id: 100001 + i })) };
  const result = await ingest(payload);
  return { matchId, payload, receiptId: result.receiptId! };
}
const verify = (matchId: string, overrides: Partial<Parameters<OutcomeVerifier['verifyProMap']>[0]> = {}) =>
  new OutcomeVerifier(database.db).verifyProMap({ matchId, snapshotAt, teamASide: 'radiant', ...overrides });

it('verifies a complete professional map from its immutable source and swaps A/B explicitly', async () => {
  const input = await example(), normal = await verify(input.matchId), swapped = await verify(input.matchId, { teamASide: 'dire' });
  expect(normal).toMatchObject({ status: 'verified', matchId: input.matchId, outcomeReceiptId: input.receiptId,
    teamAId: '11', teamBId: '22', teamAWon: true, seriesId: null, startedAt: '2024-01-01T12:00:00.000Z',
    completedAt: '2024-01-01T12:30:00.000Z', labelVerifiedAt: snapshotAt });
  expect(swapped).toMatchObject({ status: 'verified', teamAId: '22', teamBId: '11', teamAWon: false });
  if (normal.status !== 'verified') throw new Error('missing_verified_outcome');
  expect(normal.sourceEvidence.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(normal.sourceEvidence.receiptId).toBe(input.receiptId);
  expect(normal.sourceEvidence.receiptFetchedAt <= snapshotAt).toBe(true);
  expect((await sql<{ n: string }>`SELECT count(*) AS n FROM training_dataset_versions`.execute(database.db)).rows[0]!.n).toBe('0');
});

it('rejects missing maps and future verification horizons', async () => {
  expect(await verify('9223372036854775807')).toMatchObject({ status: 'unavailable', reasons: ['MAP_NOT_FOUND'] });
  const input = await example();
  expect(await verify(input.matchId, { snapshotAt: '2100-01-01T00:00:00.000Z' })).toMatchObject({ status: 'unavailable', reasons: ['SNAPSHOT_IN_FUTURE'] });
});

it('requires positive professional status, a completed winner and known native team sides', async () => {
  const cases = [
    { update: sql`is_pro=NULL`, reason: 'PRO_STATUS_UNVERIFIED' },
    { update: sql`is_pro=false`, reason: 'PRO_STATUS_UNVERIFIED' },
    { update: sql`radiant_win=NULL`, reason: 'OUTCOME_NOT_COMPLETED_AT_SNAPSHOT' },
    { update: sql`duration_seconds=NULL`, reason: 'OUTCOME_NOT_COMPLETED_AT_SNAPSHOT' },
    { update: sql`dire_team_id=NULL`, reason: 'TEAM_SIDES_UNKNOWN' },
    { update: sql`ingest_state='conflict'`, reason: 'MAP_CONFLICT' }
  ];
  for (const item of cases) {
    const input = await example();
    await sql`UPDATE matches SET ${item.update} WHERE id=${input.matchId}`.execute(database.db);
    expect(await verify(input.matchId)).toMatchObject({ status: 'unavailable', reasons: expect.arrayContaining([item.reason]) });
  }
});

it('late imports never become label evidence at an earlier snapshot', async () => {
  const input = await example();
  expect(await verify(input.matchId, { snapshotAt: '2024-01-01T12:29:59.999Z' })).toMatchObject({ status: 'unavailable', reasons: ['OUTCOME_NOT_COMPLETED_AT_SNAPSHOT'] });
  expect(await verify(input.matchId, { snapshotAt: '2025-01-01T00:00:00.000Z' })).toMatchObject({ status: 'unavailable', reasons: ['NO_MATCHING_VERIFIED_RECEIPT_AT_SNAPSHOT'] });
});

it('excludes submillisecond starts instead of rounding strict cutoffs', async () => {
  const input = await example();
  await sql`UPDATE matches SET started_at=started_at+interval '1 microsecond' WHERE id=${input.matchId}`.execute(database.db);
  expect(await verify(input.matchId)).toMatchObject({ status: 'unavailable', reasons: ['UNSUPPORTED_TIMESTAMP_PRECISION'] });
});

it('a canonical result correction requires a matching receipt and never trusts the old label', async () => {
  const input = await example();
  await sql`UPDATE matches SET radiant_win=false,data_revision=data_revision+1 WHERE id=${input.matchId}`.execute(database.db);
  expect(await verify(input.matchId)).toMatchObject({ status: 'unavailable', reasons: ['NO_MATCHING_VERIFIED_RECEIPT_AT_SNAPSHOT'] });
  const corrected = await ingest({ ...input.payload, radiant_win: false });
  expect(await verify(input.matchId)).toMatchObject({ status: 'verified', teamAWon: false, outcomeReceiptId: corrected.receiptId });
});

it('a matching provider receipt without the immutable pro league proof is insufficient', async () => {
  const input = await example(), unprovedId = String(nextId++);
  await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,radiant_team_id,dire_team_id,league_id)
    SELECT ${unprovedId},started_at,duration_seconds,radiant_win,is_pro,radiant_team_id,dire_team_id,league_id
    FROM matches WHERE id=${input.matchId}`.execute(database.db);
  await sql`INSERT INTO provider_ingest_receipts(provider,provider_match_id,canonical_match_id,adapter_version,normalizer_version,
    context_sha256,payload_sha256,fetched_at,source_payload,status,reasons)
    SELECT provider,${unprovedId},${unprovedId},adapter_version,normalizer_version,context_sha256,payload_sha256,fetched_at,
      jsonb_set(source_payload,'{match_id}',to_jsonb(${unprovedId}::text)),status,reasons
    FROM provider_ingest_receipts WHERE id=${input.receiptId}`.execute(database.db);
  expect(await verify(unprovedId)).toMatchObject({ status: 'unavailable', reasons: ['NO_MATCHING_VERIFIED_RECEIPT_AT_SNAPSHOT'] });
});

it('does not abort the whole transaction on an invalid receipt and retains the latest matching source', async () => {
  const input = await example();
  await sql`INSERT INTO provider_ingest_receipts(provider,provider_match_id,canonical_match_id,adapter_version,normalizer_version,
    context_sha256,payload_sha256,fetched_at,source_payload,status,reasons)
    SELECT provider,provider_match_id,canonical_match_id,adapter_version,'synthetic-malformed-duration',context_sha256,payload_sha256,
      fetched_at+interval '1 hour',jsonb_set(source_payload,'{duration}','"not-a-number"'::jsonb),status,reasons
    FROM provider_ingest_receipts WHERE id=${input.receiptId}`.execute(database.db);
  await database.db.transaction().setIsolationLevel('repeatable read').execute(async trx => {
    const result = await new OutcomeVerifier(trx).verifyProMap({ matchId: input.matchId, snapshotAt, teamASide: 'radiant' });
    expect(result).toMatchObject({ status: 'verified', outcomeReceiptId: input.receiptId });
    expect((await sql<{ ok: number }>`SELECT 1 AS ok`.execute(trx)).rows[0]!.ok).toBe(1);
  });
});
