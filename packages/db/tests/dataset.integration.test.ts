import { afterAll, beforeAll, expect, it } from 'vitest';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { DatasetRepository, sql } from '../src/index.js';
import { OpenDotaClient, IngestionService } from '../../ingestion/src/index.js';
import type { DatasetManifest, DatasetMapInput } from '@dota/contracts';
import { createHash } from 'node:crypto';

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  database = await testDatabase();
  await sql`INSERT INTO teams(id,name,opendota_team_id) VALUES (11,'Synthetic A',111),(22,'Synthetic B',222)`.execute(database.db);
  await sql`INSERT INTO matches(id,started_at,duration_seconds,radiant_win,is_pro,radiant_team_id,dire_team_id)
    VALUES (9007199254740993,'2024-01-01T12:00:00Z',1800,true,true,11,22)`.execute(database.db);
}, 30000);
afterAll(async () => { await database?.close(); }, 30000);
async function dataset(status = 'building') {
  return (await sql<{ id: string }>`INSERT INTO training_dataset_versions(stage,status,feature_schema_version,label_policy_version,
    cutoff_policy_version,patch_registry_revision,data_revision,code_revision,split_policy,dataset_fingerprint,frozen_at)
    VALUES ('pre_match',${status},'synthetic-v1','verified-map-v1','strict-asof-v2','0','1','synthetic-code','{}',
      ${status === 'frozen' ? 'a'.repeat(64) : null},${status === 'frozen' ? '2026-01-01T00:00:00Z' : null}) RETURNING id`.execute(database.db)).rows[0]!.id;
}
async function unprovedExample(id: string, verifiedAt: string) {
  return sql`INSERT INTO training_dataset_maps(dataset_version_id,match_id,split,team_a_id,team_b_id,cutoff_at,input_features,
    input_hash,team_a_won,label_source,label_verified_at) VALUES (${id},9007199254740993,'train',11,22,
    '2024-01-01T12:00:00Z','{}',${'0'.repeat(64)},true,'user_guess',${verifiedAt})`.execute(database.db);
}
it('refuses a label verified before the map ended', async () => {
  await expect(unprovedExample(await dataset(), '2024-01-01T12:00:01Z')).rejects.toThrow();
});
it('a matching user guess without source evidence is not a training label', async () => {
  await expect(unprovedExample(await dataset(), '2024-01-01T13:00:00Z')).rejects.toThrow();
});
it('cannot bypass freeze validation by inserting a ready-made frozen header', async () => {
  await expect(dataset('frozen')).rejects.toThrow();
});

// Synthetic provider responses exercise the real importer; only this disposable DB receives them.
const manifest: DatasetManifest = { stage: 'pre_match', featureSchemaVersion: 'synthetic-v1', labelPolicyVersion: 'verified-map-v1',
  cutoffPolicyVersion: 'strict-asof-v2', patchRegistryRevision: '0', dataRevision: 'synthetic-1', codeRevision: 'synthetic-code',
  splitPolicy: { kind: 'temporal-whole-series-v1' }, sourceManifest: { syntheticOnly: true, deployable: false } };
let mapId = 9007199254741000n;
const repository = () => new DatasetRepository(database.db);
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
async function example(offset = 0) {
  const id = String(mapId++), startedAt = new Date(Date.parse('2024-01-01T12:00:00Z') + offset * 3600000).toISOString();
  const payload = { match_id: id, start_time: Date.parse(startedAt) / 1000, duration: 1800, radiant_win: true,
    radiant_team_id: 111, dire_team_id: 222, leagueid: 77, series_id: 0,
    players: Array.from({ length: 10 }, (_, i) => ({ player_slot: i < 5 ? i : i + 123, hero_id: i + 1, account_id: 100001 + i })) };
  const imported = await ingest(payload);
  const input: DatasetMapInput = { datasetId: await repository().create(manifest), matchId: id,
    outcomeReceiptId: imported.receiptId!, teamAId: '11', teamBId: '22', cutoffAt: startedAt, split: 'train', features: { synthetic_signal: 1, unknown_signal: null } };
  return { input, payload };
}
it('derives labels from imported pro maps, swaps A/B correctly and keeps features independent', async () => {
  const { input } = await example();
  await repository().append(input);
  const other = await repository().create({ ...manifest, stage: 'post_draft' });
  await repository().append({ ...input, datasetId: other, teamAId: '22', teamBId: '11' });
  const { rows } = await sql<{ team_a_won: boolean; input_features: unknown; label_source: string; input_hash: string }>`
    SELECT team_a_won,input_features,label_source,input_hash FROM training_dataset_maps WHERE match_id=${input.matchId} ORDER BY team_a_id`.execute(database.db);
  expect(rows.map(row => row.team_a_won)).toEqual([true, false]);
  expect(rows[0]!.input_features).toEqual(input.features); expect(rows[1]!.input_hash).toBe(rows[0]!.input_hash);
  expect(rows[0]!.label_source).toBe(`opendota:receipt:${input.outcomeReceiptId}`);
});
it('twenty repeated submissions count one map, concurrent retries dedupe, changed input cannot overwrite', async () => {
  const { input } = await example();
  const results = await Promise.all(Array.from({ length: 20 }, () => repository().append(input)));
  expect(results.filter(row => !row.duplicate)).toHaveLength(1);
  expect((await sql<{ n: string }>`SELECT count(*) AS n FROM training_dataset_maps WHERE dataset_version_id=${input.datasetId}`.execute(database.db)).rows[0]!.n).toBe('1');
  await expect(repository().append({ ...input, features: { synthetic_signal: 2 } })).rejects.toThrow(/conflict/);
});
it('frozen and rejected headers and examples are immutable, including deletion and reassignment', async () => {
  for (const terminal of ['frozen','rejected'] as const) {
    const { input } = await example(); await repository().append(input);
    if (terminal === 'frozen') {
      const frozen = await repository().freeze(input.datasetId);
      expect(frozen.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(await repository().freeze(input.datasetId)).toEqual({ ...frozen, duplicate: true });
    } else await repository().reject(input.datasetId);
    await expect(sql`DELETE FROM training_dataset_maps WHERE dataset_version_id=${input.datasetId}`.execute(database.db)).rejects.toThrow(/immutable/);
    await expect(sql`UPDATE training_dataset_maps SET team_a_won=false WHERE dataset_version_id=${input.datasetId}`.execute(database.db)).rejects.toThrow(/immutable/);
    await expect(sql`UPDATE training_dataset_versions SET status='building' WHERE id=${input.datasetId}`.execute(database.db)).rejects.toThrow(/immutable/);
    await expect(sql`DELETE FROM training_dataset_versions WHERE id=${input.datasetId}`.execute(database.db)).rejects.toThrow(/immutable/);
    const target = await repository().create(manifest);
    await expect(sql`UPDATE training_dataset_maps SET dataset_version_id=${target} WHERE dataset_version_id=${input.datasetId}`.execute(database.db)).rejects.toThrow(/reassign/);
  }
});
it('building manifests cannot change stage after examples; empty freezes and arbitrary fingerprints fail', async () => {
  await expect(repository().freeze(await repository().create(manifest))).rejects.toThrow(/empty/);
  const { input } = await example(); await repository().append(input);
  await expect(sql`UPDATE training_dataset_versions SET stage='post_draft' WHERE id=${input.datasetId}`.execute(database.db)).rejects.toThrow(/manifest/);
  await expect(sql`UPDATE training_dataset_versions SET label_policy_version='user-guesses' WHERE id=${input.datasetId}`.execute(database.db)).rejects.toThrow(/manifest/);
  await expect(sql`UPDATE training_dataset_versions SET status='frozen',dataset_fingerprint=${'f'.repeat(64)}
    WHERE id=${input.datasetId}`.execute(database.db)).rejects.toThrow(/fingerprint/);
});
it('SQL rejects wrong orientation, guesses, before-end labels, forged input hashes and current-map outcome features', async () => {
  const { input } = await example(); await repository().append(input);
  for (const update of [sql`team_a_won=false`, sql`label_source='user_guess'`,
    sql`label_verified_at='2024-01-01T12:00:01Z'`, sql`input_hash=${'a'.repeat(64)}`,
    sql`input_features='{"radiant_win":1}'::jsonb,input_hash=training_json_hash('{"radiant_win":1}'::jsonb)`]) {
    await expect(sql`UPDATE training_dataset_maps SET ${update} WHERE dataset_version_id=${input.datasetId}`.execute(database.db)).rejects.toThrow();
  }
  await expect(repository().append({ ...input, teamAId: '33' })).rejects.toThrow(/orientation/);
  const other = await repository().create(manifest);
  await expect(repository().append({ ...input, datasetId: other, features: { hero_id: 1 } })).rejects.toThrow(/feature/);
});
it('rejects non-pro, unknown outcome, unknown sides, map conflict and stale revision at freeze', async () => {
  for (const update of [sql`is_pro=false`, sql`is_pro=NULL`, sql`radiant_win=NULL`, sql`dire_team_id=NULL`,
    sql`ingest_state='conflict'`, sql`data_revision=data_revision+1`]) {
    const { input } = await example(); await repository().append(input);
    await sql`UPDATE matches SET ${update} WHERE id=${input.matchId}`.execute(database.db);
    await expect(repository().freeze(input.datasetId)).rejects.toThrow(/Unverified or stale/);
  }
});
it('a correction changes only the next dataset label, not the prior frozen example or features', async () => {
  const { input, payload } = await example(); await repository().append(input); const frozen = await repository().freeze(input.datasetId);
  // Simulate an explicit canonical correction in the isolated test DB; source receipts remain immutable.
  await sql`UPDATE matches SET radiant_win=false,data_revision=data_revision+1 WHERE id=${input.matchId}`.execute(database.db);
  const corrected = await ingest({ ...payload, radiant_win: false });
  const next = await repository().create(manifest);
  await repository().append({ ...input, datasetId: next, outcomeReceiptId: corrected.receiptId! });
  const revised = await repository().freeze(next); expect(revised.fingerprint).not.toBe(frozen.fingerprint);
  const { rows } = await sql<{ dataset_version_id: string; team_a_won: boolean; input_features: unknown }>`SELECT dataset_version_id,team_a_won,input_features
    FROM training_dataset_maps WHERE match_id=${input.matchId}`.execute(database.db);
  expect(rows.find(row => row.dataset_version_id === input.datasetId)?.team_a_won).toBe(true);
  expect(rows.find(row => row.dataset_version_id === next)?.team_a_won).toBe(false);
  expect(rows.every(row => JSON.stringify(row.input_features) === JSON.stringify(rows[0]!.input_features))).toBe(true);
});
it('a known series cannot cross splits even with concurrent append; chronological folds are checked at freeze', async () => {
  const first = await example(1), second = await example(2);
  const series = (await sql<{ id: string }>`INSERT INTO series(team_a_id,team_b_id) VALUES (11,22) RETURNING id`.execute(database.db)).rows[0]!.id;
  await sql`UPDATE matches SET series_id=${series} WHERE id IN (${first.input.matchId},${second.input.matchId})`.execute(database.db);
  const attempts = await Promise.allSettled([
    repository().append(first.input), repository().append({ ...second.input, datasetId: first.input.datasetId, split: 'test' })]);
  expect(attempts.filter(row => row.status === 'fulfilled')).toHaveLength(1);
  expect(attempts.filter(row => row.status === 'rejected')).toHaveLength(1);
  const later = await example(4), earlier = await example(3);
  await repository().append(later.input);
  await repository().append({ ...earlier.input, datasetId: later.input.datasetId, split: 'test' });
  await expect(repository().freeze(later.input.datasetId)).rejects.toThrow(/chronological/);
});
it('freeze racing an append leaves either a complete frozen snapshot or a rejected append', async () => {
  const first = await example(5), second = await example(6); await repository().append(first.input);
  const results = await Promise.allSettled([repository().freeze(first.input.datasetId),
    repository().append({ ...second.input, datasetId: first.input.datasetId, split: 'test' })]);
  expect(results[0]!.status).toBe('fulfilled');
  const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM training_dataset_maps WHERE dataset_version_id=${first.input.datasetId}`.execute(database.db);
  expect(rows[0]!.n).toBe(results[1]!.status === 'fulfilled' ? '2' : '1');
});
it('a receipt of another map cannot be substituted, and professional classification evidence is mandatory', async () => {
  const first = await example(), other = await example();
  await expect(repository().append({ ...first.input, outcomeReceiptId: other.input.outcomeReceiptId })).rejects.toThrow(/receipt/);
  const { rows } = await sql<{ id: string }>`INSERT INTO provider_ingest_receipts(provider,provider_match_id,canonical_match_id,
    adapter_version,normalizer_version,context_sha256,payload_sha256,fetched_at,source_payload,status,reasons)
    SELECT provider,provider_match_id,canonical_match_id,adapter_version,'synthetic-no-pro-proof',context_sha256,payload_sha256,
      fetched_at,source_payload,status,reasons FROM provider_ingest_receipts WHERE id=${first.input.outcomeReceiptId} RETURNING id`.execute(database.db);
  await expect(repository().append({ ...first.input, outcomeReceiptId: rows[0]!.id })).rejects.toThrow(/league evidence/);
});

it('fingerprint reproduces from canonical UTF-8 bytes across timezones and preserves bigint IDs as strings', async () => {
  const { input } = await example(); await repository().append(input); const frozen = await repository().freeze(input.datasetId);
  for (const timezone of ['UTC','Pacific/Honolulu']) {
    await database.db.transaction().execute(async trx => {
      await sql`SELECT set_config('TimeZone',${timezone},true)`.execute(trx);
      const { rows } = await sql<{ content: string }>`SELECT training_dataset_content(${input.datasetId})::text AS content`.execute(trx);
      expect(createHash('sha256').update(rows[0]!.content, 'utf8').digest('hex')).toBe(frozen.fingerprint);
      expect(JSON.parse(rows[0]!.content).maps[0].match_id).toBe(input.matchId);
    });
  }
});
