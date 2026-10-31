import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ContextObservation } from '@dota/contracts';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { MatchContextRepository, sql } from '../src/index.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
let repository: MatchContextRepository;
let nextId = 9007199254740993n;
const cutoffAt = '2024-01-01T12:00:00.000Z';
beforeAll(async () => {
  database = await testDatabase(); repository = new MatchContextRepository(database.db);
}, 30000);
afterAll(async () => { await database?.close(); });
async function map() {
  const id = String(nextId++);
  await sql`INSERT INTO matches(id,started_at) VALUES (${id},${cutoffAt})`.execute(database.db);
  return id;
}
function observation(matchId: string, overrides: Partial<ContextObservation> = {}): ContextObservation {
  return { matchId, fact: { field: 'map_number', value: 2 }, eventAt: '2024-01-01T11:00:00.000Z', knownAt: cutoffAt,
    fetchedAt: '2026-10-31T12:00:00.000Z', availability: 'verified_asof', earliestStage: 'pre_match',
    provider: 'synthetic-archive', providerRecordId: 'synthetic:map', evidenceRef: 'synthetic:dated-record',
    adapterVersion: 'test-v1', reviewState: 'accepted', ...overrides };
}
async function read(matchId: string, stage: 'pre_match' | 'post_draft' = 'pre_match') {
  return repository.readAsOf({ matchId, cutoffAt, stage });
}

it('round-trips three independent clocks, UUID series and BIGINT native lineup slots', async () => {
  const matchId = await map();
  const rows = [observation(matchId),
    observation(matchId, { fact: { field: 'series_id', value: '123e4567-e89b-42d3-a456-426614174000' } }),
    observation(matchId, { fact: { field: 'lineup', value: [{ playerSlot: 128, playerId: '9007199254740999' }, { playerSlot: 0, playerId: null }] } }),
    observation(matchId, { fact: { field: 'roles', value: [{ playerSlot: 128, playerId: '9007199254740999', rolePos: 4, basis: 'estimated', confidence: 0.2 }] } })];
  for (const row of rows) await repository.append(row);
  const result = await read(matchId);
  expect(result.status).toBe('resolved');
  expect(result.context?.dataRevision).toBe('4');
  expect(result.context?.fields.filter(field => field.status === 'available')).toHaveLength(4);
  const stored = (await sql<{ event_at: Date; known_at: Date; fetched_at: Date }>`SELECT event_at,known_at,fetched_at
    FROM match_field_observations WHERE match_id=${matchId} ORDER BY id LIMIT 1`.execute(database.db)).rows[0]!;
  expect(stored.event_at.toISOString()).toBe(rows[0]!.eventAt);
  expect(stored.known_at.toISOString()).toBe(cutoffAt);
  expect(stored.fetched_at.toISOString()).toBe('2026-10-31T12:00:00.000Z');
  expect(result.context?.fields.find(field => field.field === 'lineup')?.fact).toEqual({ field: 'lineup',
    value: [{ playerSlot: 0, playerId: null }, { playerSlot: 128, playerId: '9007199254740999' }] });
});

it('legacy raw observations and canonical completed-map fields never become as-of evidence', async () => {
  const matchId = await map();
  await sql`UPDATE matches SET radiant_win=true,duration_seconds=1800,map_number=2,first_pick_side='dire' WHERE id=${matchId}`.execute(database.db);
  await sql`INSERT INTO match_field_observations(match_id,field_name,provider,value,fetched_at,adapter_version,value_sha256)
    VALUES (${matchId},'players','synthetic','[]'::jsonb,'2026-10-31T12:00:00Z','test-v1',${'0'.repeat(64)})`.execute(database.db);
  const old = (await sql<{ event_at: null; known_at: null; availability_class: string; earliest_stage: string }>`
    SELECT event_at,known_at,availability_class,earliest_stage FROM match_field_observations WHERE match_id=${matchId}`.execute(database.db)).rows[0];
  expect(old).toEqual({ event_at: null, known_at: null, availability_class: 'unknown', earliest_stage: 'post_match' });
  await repository.append(observation(matchId, { availability: 'retrospective_fact', knownAt: null }));
  const result = await read(matchId);
  expect(result.context?.fields.every(field => field.fact === null)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('radiant_win');
  expect(JSON.stringify(result)).not.toContain('duration_seconds');
});

it('concurrent retries are idempotent including evidence revision and shuffled native slots', async () => {
  const matchId = await map();
  const value = [{ playerSlot: 128, playerId: '22' }, { playerSlot: 0, playerId: '11' }];
  const ids = await Promise.all(Array.from({ length: 5 }, (_, i) => repository.append(observation(matchId,
    { fact: { field: 'lineup', value: i % 2 ? [...value].reverse() : value } }))));
  expect(new Set(ids).size).toBe(1);
  expect((await read(matchId)).context?.dataRevision).toBe('1');
  expect((await sql<{ count: string }>`SELECT count(*) FROM match_field_observations WHERE match_id=${matchId}`.execute(database.db)).rows[0]?.count).toBe('1');
});

it('keeps stage gates, first-pick side and pre-map score separate', async () => {
  const matchId = await map();
  await repository.append(observation(matchId, { fact: { field: 'first_pick_side', value: 'dire' }, earliestStage: 'post_draft' }));
  const scoreId = await repository.append(observation(matchId, { fact: { field: 'series_score_before', value: { radiant: 0, dire: 1 } } }));
  expect((await read(matchId)).context?.fields.find(field => field.field === 'first_pick_side')?.fact).toBeNull();
  expect((await read(matchId, 'post_draft')).context?.fields.find(field => field.field === 'first_pick_side')?.fact)
    .toEqual({ field: 'first_pick_side', value: 'dire' });
  expect((await read(matchId, 'post_draft')).context?.fields.find(field => field.field === 'series_score_before')?.fact).toBeNull();
  expect((await sql<{ value: unknown }>`SELECT value FROM match_field_observations WHERE id=${scoreId}`.execute(database.db)).rows[0]?.value)
    .toEqual({ radiant: 0, dire: 1 });
});

it('rejects missing map, post-start cutoff and canonical provider conflict', async () => {
  expect((await read('777')).reason).toBe('MAP_NOT_FOUND');
  const matchId = await map();
  expect((await repository.readAsOf({ matchId, stage: 'post_draft', cutoffAt: '2024-01-01T12:00:00.001Z' })).reason).toBe('CUTOFF_AFTER_MAP_START');
  await sql`UPDATE matches SET ingest_state='conflict' WHERE id=${matchId}`.execute(database.db);
  expect((await read(matchId)).reason).toBe('MAP_CONFLICT');
});

it('appends corrections without rewriting proof; future knowledge does not alter past fields', async () => {
  const matchId = await map();
  const id = await repository.append(observation(matchId));
  const original = await read(matchId);
  await repository.append(observation(matchId, { fact: { field: 'map_number', value: 3 }, knownAt: '2025-01-01T00:00:00.000Z' }));
  expect((await read(matchId)).context?.fields).toEqual(original.context?.fields);
  await expect(sql`UPDATE match_field_observations SET known_at=NULL WHERE id=${id}`.execute(database.db)).rejects.toThrow(/immutable/i);
  await expect(sql`DELETE FROM match_field_observations WHERE id=${id}`.execute(database.db)).rejects.toThrow(/immutable/i);
  await repository.append(observation(matchId, { fact: { field: 'map_number', value: 3 }, provider: 'synthetic-conflicting-archive' }));
  expect((await read(matchId)).context?.fields.find(field => field.field === 'map_number')?.reasons).toEqual(['CONFLICT']);
});

it('enforces critical provenance constraints even when SQL bypasses the writer', async () => {
  const matchId = await map();
  const insert = (knownAt: string | null, evidence: string | null, field: string, stage: string) => sql`
    INSERT INTO match_field_observations(match_id,field_name,provider,value,fetched_at,known_at,evidence_ref,
      adapter_version,value_sha256,context_sha256,availability_class,earliest_stage)
    VALUES (${matchId},${field},'synthetic','null'::jsonb,'2026-10-31T12:00:00Z',${knownAt},${evidence},
      'test-v1',${'0'.repeat(64)},${'1'.repeat(64)},'verified_asof',${stage})`.execute(database.db);
  await expect(insert(null, 'proof', 'context.map_number', 'pre_match')).rejects.toThrow(/ck_context_evidence/);
  await expect(insert(cutoffAt, null, 'context.map_number', 'pre_match')).rejects.toThrow(/ck_context_evidence/);
  await expect(insert('2027-01-01T00:00:00Z', 'proof', 'context.map_number', 'pre_match')).rejects.toThrow(/ck_context_evidence/);
  await expect(insert(cutoffAt, 'proof', 'context.heroes', 'pre_match')).rejects.toThrow(/ck_context_evidence/);
  await expect(insert(cutoffAt, 'proof', 'context.radiant_win', 'post_match')).rejects.toThrow(/ck_context_evidence/);
});

it('rejects sub-millisecond evidence instead of rounding future knowledge into the cutoff', async () => {
  const matchId = await map();
  await expect(sql`INSERT INTO match_field_observations(match_id,field_name,provider,value,fetched_at,known_at,evidence_ref,
    adapter_version,value_sha256,context_sha256,availability_class,earliest_stage,review_state)
    VALUES (${matchId},'context.map_number','synthetic','2'::jsonb,'2026-10-31T12:00:00Z','2024-01-01T12:00:00.000001Z','proof',
      'test-v1',${'0'.repeat(64)},${'1'.repeat(64)},'verified_asof','pre_match','accepted')`.execute(database.db))
    .rejects.toThrow(/ck_context_evidence/);
});

it('rejects malformed typed values on write and fails closed if SQL stored one', async () => {
  const matchId = await map();
  await expect(repository.append(observation(matchId, { fact: { field: 'map_number', value: 0 } }))).rejects.toThrow();
  await sql`INSERT INTO match_field_observations(match_id,field_name,provider,value,fetched_at,known_at,evidence_ref,
    adapter_version,value_sha256,context_sha256,availability_class,earliest_stage,review_state)
    VALUES (${matchId},'context.map_number','synthetic','"bad"'::jsonb,'2026-10-31T12:00:00Z',${cutoffAt},'proof',
      'test-v1',${'0'.repeat(64)},${'1'.repeat(64)},'verified_asof','pre_match','accepted')`.execute(database.db);
  await expect(read(matchId)).rejects.toThrow();
});
