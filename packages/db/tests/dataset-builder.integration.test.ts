// SYNTHETIC fixtures only: real importer/SQL in a disposable PostgreSQL database.
// The explicit syntheticOnly builder is never the production CLI path.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { ContextObservation, DatasetBuildRequest } from '@dota/contracts';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { GameRegistryRepository, IdentityRepository, MatchContextRepository, sql } from '../src/index.js';
import { DatasetBuilder } from '../src/dataset-builder.js';
import { OutcomeVerifier } from '../src/outcome-verifier.js';
import * as identityReader from '../src/identity-repository.js';
import { OpenDotaClient, IngestionService } from '../../ingestion/src/index.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
let builder: DatasetBuilder;
let nextMap = 9007199254750000n;
let nextSeries = 1000;
const fetchedAt = '2026-10-30T00:00:00.000Z';
const snapshotAt = '2026-10-31T20:00:00.000Z';
const early = '2023-01-01T00:00:00.000Z';
const playerIds = Array.from({ length: 10 }, (_, i) => String(9007199254741001n + BigInt(i)));
const slot = (index: number) => index < 5 ? index : index + 123;
const time = (day: number, hour = 0) => new Date(Date.UTC(2024, 0, day, hour)).toISOString();
const query = (day: number, overrides: Partial<DatasetBuildRequest> = {}): DatasetBuildRequest => ({
  stage: 'pre_match', teamASide: 'radiant', fromAt: time(day), trainUntil: time(day, 6),
  calibrationUntil: time(day, 12), validationUntil: time(day, 18), toAt: time(day + 1),
  snapshotAt, maxMaps: 100, ...overrides
});
const run = (day: number, persist = false, overrides: Partial<DatasetBuildRequest> = {}) =>
  builder.prepare(query(day, overrides), 'synthetic-builder-code', persist);

beforeAll(async () => {
  database = await testDatabase(); builder = new DatasetBuilder(database.db, { syntheticOnly: true });
  await sql`INSERT INTO teams(id,name,opendota_team_id) VALUES (11,'Synthetic A',111),(22,'Synthetic B',222)`.execute(database.db);
  const identities = new IdentityRepository(database.db);
  for (const [i, id] of playerIds.entries()) {
    await sql`INSERT INTO players(id,nickname) VALUES (${id},'Synthetic dataset player')`.execute(database.db);
    await identities.appendAccountEvidence({ playerId: id, externalAccountId: String(100001 + i), provider: 'opendota',
      status: 'verified', eventAt: early, knownAt: early, fetchedAt, source: 'synthetic', evidenceRef: 'synthetic:account' });
  }
  await sql`INSERT INTO patches(id,label,released_at) VALUES (1,'synthetic-dataset',${early})`.execute(database.db);
  await new GameRegistryRepository(database.db).appendPatch({ patchId: '1', releasedAt: early,
    coverageUntil: '2025-01-01T00:00:00.000Z', eventAt: early, knownAt: early, fetchedAt,
    source: 'synthetic', evidenceRef: 'synthetic:release', reviewState: 'accepted' });
}, 30000);
afterAll(async () => { await database?.close(); }, 30000);

async function ingest(payload: Record<string, unknown>, receiptTime = fetchedAt) {
  let clock = Date.parse(receiptTime);
  const client = new OpenDotaClient({}, { now: () => clock, sleep: async ms => { clock += ms; }, fetch: async url => {
    const data = url.pathname === '/api/heroes' ? Array.from({ length: 10 }, (_, i) => ({ id: i + 1,
      name: `synthetic_${i}`, localized_name: `Synthetic ${i}` })) : url.pathname === '/api/leagues'
      ? [{ leagueid: 77, name: 'Synthetic professional league', tier: 'professional' }] : payload;
    return new Response(JSON.stringify(data));
  } });
  return new IngestionService(database.db, client).ingest(String(payload.match_id));
}
async function series() {
  const providerId = String(nextSeries++);
  const id = (await sql<{ id: string }>`INSERT INTO series(team_a_id,team_b_id,provider,provider_series_id)
    VALUES (11,22,'opendota',${providerId}) RETURNING id`.execute(database.db)).rows[0]!.id;
  return { id, providerId };
}
type ProofMode = 'complete' | 'missing' | 'late' | 'future_fetch' | 'wrong_team' | 'wrong_lineup' | 'wrong_heroes' | 'retrospective';
async function map(day: number, options: { hour?: number; series?: Awaited<ReturnType<typeof series>> | null;
  proof?: ProofMode; receiptTime?: string } = {}) {
  const matchId = String(nextMap++), startedAt = time(day, options.hour ?? 1);
  const group = options.series === undefined ? await series() : options.series;
  const payload = { match_id: matchId, start_time: Date.parse(startedAt) / 1000, duration: 1800, radiant_win: true,
    radiant_team_id: 111, dire_team_id: 222, leagueid: 77, series_id: group?.providerId ?? 0,
    players: Array.from({ length: 10 }, (_, i) => ({ player_slot: slot(i), hero_id: i + 1, account_id: 100001 + i })) };
  const result = await ingest(payload, options.receiptTime);
  const mode = options.proof ?? 'complete';
  if (mode !== 'missing') {
    const lineup = playerIds.map((playerId, i) => ({ playerSlot: slot(i), playerId }));
    if (mode === 'wrong_lineup') [lineup[0]!.playerId, lineup[5]!.playerId] = [lineup[5]!.playerId, lineup[0]!.playerId];
    const heroes = Array.from({ length: 10 }, (_, i) => ({ playerSlot: slot(i), heroId: i + 1 }));
    if (mode === 'wrong_heroes') [heroes[0]!.heroId, heroes[5]!.heroId] = [heroes[5]!.heroId, heroes[0]!.heroId];
    const facts: ContextObservation['fact'][] = [
      { field: 'lineup', value: lineup },
      { field: 'teams', value: mode === 'wrong_team' ? { radiantTeamId: '22', direTeamId: '11' } : { radiantTeamId: '11', direTeamId: '22' } },
      { field: 'heroes', value: heroes }
    ];
    for (const fact of facts) await new MatchContextRepository(database.db).append({ matchId, fact,
      eventAt: early, knownAt: mode === 'retrospective' ? null : mode === 'late' ? time(day, 2) : early,
      fetchedAt: mode === 'future_fetch' ? '2026-11-02T00:00:00.000Z' : fetchedAt,
      availability: mode === 'retrospective' ? 'retrospective_fact' : 'verified_asof',
      earliestStage: mode === 'retrospective' ? 'post_match' : fact.field === 'heroes' ? 'post_draft' : 'pre_match',
      provider: 'synthetic-archive', providerRecordId: null, evidenceRef: 'synthetic:dated-context',
      adapterVersion: 'synthetic-v1', reviewState: 'accepted' });
  }
  return { matchId, startedAt, payload, receiptId: result.receiptId!, group };
}
async function countDatasets() {
  return (await sql<{ n: string }>`SELECT count(*) AS n FROM training_dataset_versions`.execute(database.db)).rows[0]!.n;
}
function requireFrozen(result: Awaited<ReturnType<typeof run>>) {
  expect(result.status).toBe('frozen');
  if (result.status !== 'frozen') throw new Error(JSON.stringify(result));
  return result;
}
async function frozenInputs(datasetId: string) {
  const { rows } = await sql<{ source_manifest: { inputs: { matchId: string; inputSnapshot: { stage: string;
    facts: { field: string; value: unknown }[] }; inputSnapshotHash: string;
    actualParticipants: { player_slot: number; source_account_id: string | null; hero_id: number | null }[];
    quality: { validatorVersion: string; draftOrderValid: boolean | null }[]; qualityFingerprint: string }[];
    trainingReady: boolean; deployable: boolean } }>`
    SELECT source_manifest FROM training_dataset_versions WHERE id=${datasetId}`.execute(database.db);
  return rows[0]!.source_manifest;
}

it('freezes strict pre/post contexts, maps A/B by native side, and exports reproducible immutable bytes', async () => {
  const sample = await map(1);
  const pre = requireFrozen(await run(1, true));
  const post = requireFrozen(await run(1, true, { stage: 'post_draft', teamASide: 'dire' }));
  const before = await builder.exportFrozen(pre.datasetId);
  expect(createHash('sha256').update(before.content).digest('hex')).toBe(before.fingerprint);
  expect((await builder.exportFrozen(pre.datasetId)).content).toBe(before.content);
  const { rows } = await sql<{ team_a_won: boolean; input_features: unknown; match_id: string }>`
    SELECT team_a_won,input_features,match_id FROM training_dataset_maps
    WHERE dataset_version_id IN (${pre.datasetId},${post.datasetId}) ORDER BY team_a_id`.execute(database.db);
  expect(rows.map(row => row.team_a_won)).toEqual([true, false]);
  expect(rows.every(row => row.match_id === sample.matchId && JSON.stringify(row.input_features) === '{}')).toBe(true);
  const preManifest = await frozenInputs(pre.datasetId), postManifest = await frozenInputs(post.datasetId);
  expect(preManifest).toMatchObject({ trainingReady: false, deployable: false });
  expect(preManifest.inputs[0]!.inputSnapshot.facts.map(f => f.field)).not.toContain('heroes');
  expect(postManifest.inputs[0]!.inputSnapshot.facts.map(f => f.field)).toContain('heroes');
  expect(JSON.stringify(preManifest.inputs[0]!.inputSnapshot)).not.toMatch(/radiant_win|duration|kills|gpm|teamAWon/);
  expect(preManifest.inputs[0]!.actualParticipants.map(p => p.player_slot)).toEqual(Array.from({ length: 10 }, (_, i) => slot(i)));
  expect(preManifest.inputs[0]!.quality).not.toHaveLength(0);
  expect(preManifest.inputs[0]!.quality.every(p => p.validatorVersion.length > 0 && p.draftOrderValid === null)).toBe(true);
  expect(preManifest.inputs[0]!.qualityFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(preManifest.inputs[0]!.inputSnapshot).not.toHaveProperty('actualParticipants');
  await expect(sql`UPDATE training_dataset_maps SET team_a_won=false WHERE dataset_version_id=${pre.datasetId}`.execute(database.db)).rejects.toThrow(/immutable|building/i);
}, 30000);

it('preview has no dataset writes and production refuses explicitly synthetic context evidence', async () => {
  const sample = await map(2), before = await countDatasets();
  const revision = (await sql<{ data_revision: string }>`SELECT data_revision FROM matches WHERE id=${sample.matchId}`.execute(database.db)).rows[0]!.data_revision;
  expect(await run(2)).toMatchObject({ status: 'prepared', datasetId: null, summary: { eligible: 1, trainingReady: false } });
  expect(await countDatasets()).toBe(before);
  expect((await sql<{ data_revision: string }>`SELECT data_revision FROM matches WHERE id=${sample.matchId}`.execute(database.db)).rows[0]!.data_revision).toBe(revision);
  const production = await new DatasetBuilder(database.db).prepare(query(2), 'synthetic-test-code', true);
  expect(production).toMatchObject({ status: 'unavailable', reason: 'NO_ELIGIBLE_MAPS', summary: { byReason: { SYNTHETIC_EVIDENCE_FORBIDDEN: 1 } } });
  expect(await countDatasets()).toBe(before);
}, 30000);

it('missing, late, future-fetched and reconstructed lineups never become strict historical context', async () => {
  for (const [index, proof] of (['missing', 'late', 'future_fetch', 'retrospective'] as const).entries()) {
    await map(3 + index, { proof });
    expect(await run(3 + index, true)).toMatchObject({ status: 'unavailable', reason: 'NO_ELIGIBLE_MAPS',
      summary: { eligible: 0, byReason: { CONTEXT_LINEUP_UNAVAILABLE: 1 } } });
  }
}, 30000);

it('rejects wrong historical organization sides, canonical lineup identity, and post-draft hero sides', async () => {
  await map(7, { proof: 'wrong_team' }); await map(8, { proof: 'wrong_lineup' }); await map(9, { proof: 'wrong_heroes' });
  expect(await run(7)).toMatchObject({ summary: { byReason: { CONTEXT_TEAM_SIDE_MISMATCH: 1 } } });
  expect(await run(8)).toMatchObject({ summary: { byReason: { IDENTITY_OR_LINEUP_MISMATCH: 1 } } });
  expect(await run(9, false, { stage: 'post_draft' })).toMatchObject({ summary: { byReason: { OBSERVED_HERO_MISMATCH: 1 } } });
  expect(await run(9)).toMatchObject({ status: 'prepared', summary: { eligible: 1 } });
}, 30000);

it('keeps all locally known series together and excludes unknown, cross-boundary and outside-window series', async () => {
  const crossing = await series(), outside = await series(), same = await series();
  await map(10, { hour: 5, series: crossing }); await map(10, { hour: 6, series: crossing });
  await map(10, { hour: 0, series: outside }); await map(9, { hour: 23, series: outside });
  await map(10, { hour: 8, series: null });
  await map(10, { hour: 13, series: same }); await map(10, { hour: 14, series: same });
  const result = requireFrozen(await run(10, true));
  expect(result.summary).toMatchObject({ candidates: 6, eligible: 2, bySplit: { validation: 2 },
    byReason: { SERIES_CROSSES_SPLIT: 2, SERIES_OUTSIDE_WINDOW: 1, SERIES_UNKNOWN: 1 } });
  expect((await sql<{ n: string }>`SELECT count(*) AS n FROM training_dataset_maps WHERE dataset_version_id=${result.datasetId}`.execute(database.db)).rows[0]!.n).toBe('2');
}, 30000);

it('refuses candidate overflow and future snapshots without creating a partial dataset', async () => {
  await map(11); await map(11, { hour: 2 }); const before = await countDatasets();
  expect(await run(11, true, { maxMaps: 1 })).toMatchObject({ status: 'unavailable', reason: 'CANDIDATE_LIMIT_EXCEEDED', datasetId: null });
  const group = await series(); await map(21, { series: group }); await map(22, { series: group });
  expect(await run(21, true, { maxMaps: 1 })).toMatchObject({ status: 'unavailable', reason: 'SERIES_INVENTORY_LIMIT_EXCEEDED', datasetId: null });
  expect(await run(11, true, { snapshotAt: '2099-01-01T00:00:00.000Z' })).toMatchObject({ status: 'unavailable', reason: 'SNAPSHOT_IN_FUTURE' });
  expect(await countDatasets()).toBe(before);
}, 30000);

it('a correction and a later import produce new versions while the frozen bytes and old inputs stay unchanged', async () => {
  const sample = await map(12), original = requireFrozen(await run(12, true));
  const bytes = await builder.exportFrozen(original.datasetId), originalInput = (await frozenInputs(original.datasetId)).inputs[0]!;
  // Explicit canonical correction in this isolated test database; receipts stay immutable.
  await sql`UPDATE matches SET radiant_win=false,data_revision=data_revision+1 WHERE id=${sample.matchId}`.execute(database.db);
  await ingest({ ...sample.payload, radiant_win: false }, '2026-10-30T01:00:00.000Z');
  const corrected = requireFrozen(await run(12, true));
  expect(corrected.fingerprint).not.toBe(original.fingerprint);
  expect((await frozenInputs(corrected.datasetId)).inputs[0]!.inputSnapshotHash).toBe(originalInput.inputSnapshotHash);
  expect((await sql<{ team_a_won: boolean }>`SELECT team_a_won FROM training_dataset_maps WHERE dataset_version_id=${corrected.datasetId}`.execute(database.db)).rows[0]!.team_a_won).toBe(false);
  await map(12, { hour: 3 });
  expect(requireFrozen(await run(12, true)).summary.eligible).toBe(2);
  expect(await builder.exportFrozen(original.datasetId)).toEqual(bytes);
}, 30000);

it('ten actual prediction audit rows for one map never inflate dataset examples', async () => {
  const sample = await map(13);
  const owner = (await sql<{ id: string }>`INSERT INTO app_users(login,password_hash) VALUES ('synthetic-builder-owner',${'x'.repeat(32)}) RETURNING id`.execute(database.db)).rows[0]!.id;
  const scenarioId = (await sql<{ id: string }>`INSERT INTO scenarios(owner_user_id,team_a_id,team_b_id,cutoff_at)
    VALUES (${owner},11,22,${sample.startedAt}) RETURNING id`.execute(database.db)).rows[0]!.id;
  await sql`WITH inserted AS (INSERT INTO prediction_runs(scenario_id,scenario_revision,stage,status,cutoff_at,input_hash,data_revision,input_snapshot)
    SELECT ${scenarioId}::uuid,1,'pre_match','unavailable',${sample.startedAt}::timestamptz,${'1'.repeat(64)},'synthetic','{}'::jsonb FROM generate_series(1,10)
    RETURNING id) INSERT INTO prediction_outcomes(prediction_run_id,match_id,team_a_won,outcome_source)
    SELECT id,${sample.matchId}::bigint,true,'synthetic:forecast-audit-only' FROM inserted`.execute(database.db);
  expect((await sql<{ n: string }>`SELECT count(*) AS n FROM prediction_outcomes WHERE match_id=${sample.matchId}`.execute(database.db)).rows[0]!.n).toBe('10');
  const result = requireFrozen(await run(13, true));
  expect(result.summary).toMatchObject({ candidates: 1, eligible: 1 });
  expect((await sql<{ n: string }>`SELECT count(*) AS n FROM training_dataset_maps WHERE dataset_version_id=${result.datasetId}`.execute(database.db)).rows[0]!.n).toBe('1');
}, 30000);

it('failed freeze transaction rolls back both header and every appended map', async () => {
  await map(14); const second = await map(14, { hour: 2 }); const before = await countDatasets();
  await sql`CREATE FUNCTION synthetic_fail_builder_map() RETURNS trigger LANGUAGE plpgsql AS
    'BEGIN RAISE EXCEPTION ''synthetic transaction failure''; END'`.execute(database.db);
  await sql`CREATE TRIGGER synthetic_fail_builder_insert BEFORE INSERT ON training_dataset_maps
    FOR EACH ROW WHEN (NEW.match_id=${sql.lit(second.matchId)}::bigint) EXECUTE FUNCTION synthetic_fail_builder_map()`.execute(database.db);
  try { await expect(run(14, true)).rejects.toThrow(/synthetic transaction failure/); }
  finally {
    await sql`DROP TRIGGER synthetic_fail_builder_insert ON training_dataset_maps`.execute(database.db);
    await sql`DROP FUNCTION synthetic_fail_builder_map()`.execute(database.db);
  }
  expect(await countDatasets()).toBe(before);
  expect((await sql<{ n: string }>`SELECT count(*) AS n FROM training_dataset_maps WHERE match_id=${second.matchId}`.execute(database.db)).rows[0]!.n).toBe('0');
  expect(requireFrozen(await run(14, true)).summary.eligible).toBe(2);
}, 30000);

it('OutcomeVerifier rejects unknown sides, non-pro, conflicts, late receipts and unsupported microsecond starts', async () => {
  const verifier = new OutcomeVerifier(database.db);
  expect(await verifier.verifyProMap({ matchId: '999', snapshotAt, teamASide: 'radiant' })).toMatchObject({ status: 'unavailable', reasons: ['MAP_NOT_FOUND'] });
  const changes = [sql`dire_team_id=NULL`, sql`is_pro=NULL`, sql`ingest_state='conflict'`,
    sql`started_at=started_at+interval '1 microsecond'`] as const;
  const reasons = ['TEAM_SIDES_UNKNOWN', 'PRO_STATUS_UNVERIFIED', 'MAP_CONFLICT', 'UNSUPPORTED_TIMESTAMP_PRECISION'];
  for (const [i, change] of changes.entries()) {
    const sample = await map(15 + i); await sql`UPDATE matches SET ${change} WHERE id=${sample.matchId}`.execute(database.db);
    expect(await verifier.verifyProMap({ matchId: sample.matchId, snapshotAt, teamASide: 'radiant' })).toMatchObject({ status: 'unavailable', reasons: expect.arrayContaining([reasons[i]]) });
  }
  const late = await map(19, { receiptTime: '2026-11-02T00:00:00.000Z' });
  expect(await verifier.verifyProMap({ matchId: late.matchId, snapshotAt, teamASide: 'radiant' })).toMatchObject({ status: 'unavailable', reasons: ['NO_MATCHING_VERIFIED_RECEIPT_AT_SNAPSHOT'] });
}, 30000);

it('identical sequential and concurrent builds reuse the same fingerprint and leave no building rows', async () => {
  await map(23); const before = BigInt(await countDatasets());
  const first = requireFrozen(await run(23, true)), second = requireFrozen(await run(23, true));
  expect(second).toMatchObject({ datasetId: first.datasetId, fingerprint: first.fingerprint, duplicate: true });
  await map(24);
  const concurrent = (await Promise.all([run(24, true), run(24, true)])).map(requireFrozen);
  expect(concurrent[0]!.datasetId).toBe(concurrent[1]!.datasetId);
  expect(concurrent[0]!.fingerprint).toBe(concurrent[1]!.fingerprint);
  expect(BigInt(await countDatasets()) - before).toBe(2n);
  expect((await sql<{ n: string }>`SELECT count(*) AS n FROM training_dataset_versions WHERE status='building'`.execute(database.db)).rows[0]!.n).toBe('0');
}, 30000);

it('identity evidence row ordering cannot change frozen inputs or dataset identity', async () => {
  await map(25);
  const first = requireFrozen(await run(25, true));
  const firstInput = (await frozenInputs(first.datasetId)).inputs[0]!;
  const original = identityReader.readAccountEvidence;
  const spy = vi.spyOn(identityReader, 'readAccountEvidence').mockImplementation(async (...args) =>
    (await original(...args)).reverse());
  try {
    const reversed = requireFrozen(await run(25, true));
    expect(spy).toHaveBeenCalled();
    expect((await frozenInputs(reversed.datasetId)).inputs[0]!.inputSnapshotHash).toBe(firstInput.inputSnapshotHash);
    expect(reversed).toMatchObject({ datasetId: first.datasetId, fingerprint: first.fingerprint, duplicate: true });
  } finally { spy.mockRestore(); }
}, 30000);

it('CLI previews/builds fail closed, exports exact verified bytes and refuses overwriting an export', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dota-synthetic-dataset-cli-'));
  const config = join(directory, 'config.json'), output = join(directory, 'dataset.json');
  const script = fileURLToPath(new URL('../../../scripts/prepare-dataset.mjs', import.meta.url));
  const cli = (...args: string[]) => spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, DATABASE_URL: database.url }, encoding: 'utf8', timeout: 15000, windowsHide: true
  });
  try {
    await writeFile(config, JSON.stringify(query(20)), 'utf8');
    const before = await countDatasets();
    for (const mode of ['preview', 'build']) {
      const result = cli(mode, config);
      expect(result.error).toBeUndefined(); expect(result.status).toBe(3);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'unavailable', reason: 'NO_ELIGIBLE_MAPS', datasetId: null });
    }
    expect(await countDatasets()).toBe(before);
    await map(20);
    const blocked = cli('build', config);
    expect(blocked.status).toBe(3);
    expect(JSON.parse(blocked.stdout)).toMatchObject({ summary: { byReason: { SYNTHETIC_EVIDENCE_FORBIDDEN: 1 } } });
    const frozen = requireFrozen(await run(20, true)), exported = cli('export', frozen.datasetId, output);
    expect(exported.status).toBe(0);
    expect(JSON.parse(exported.stdout)).toMatchObject({ status: 'exported', fingerprint: frozen.fingerprint });
    const bytes = await readFile(output);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(frozen.fingerprint);
    expect(bytes.toString()).toBe((await builder.exportFrozen(frozen.datasetId)).content);
    const overwrite = cli('export', frozen.datasetId, output);
    expect(overwrite.status).toBe(1); expect(overwrite.stderr).toContain('уже существует');
    expect(await readFile(output)).toEqual(bytes);
  } finally {
    // Remove only the two known test files and then their empty directory; no recursive cleanup.
    for (const path of [config, output]) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  }
}, 30000);
