import { afterEach, beforeEach, expect, it } from 'vitest';
import { testDatabase } from '../../../tests/helpers/postgres.js';
import { GameContextRepository, GameRegistryRepository, MatchContextRepository, sql } from '../src/index.js';
import { query, cutoffAt, before, clocks, registry, observations, withoutId } from './game-fixtures.js';

let database: Awaited<ReturnType<typeof testDatabase>>;
let writer: GameRegistryRepository;
let reader: GameContextRepository;
beforeEach(async () => {
  database = await testDatabase(); writer = new GameRegistryRepository(database.db); reader = new GameContextRepository(database.db);
  await sql`INSERT INTO patches(id,label,released_at) VALUES (1,'synthetic-patch',${before})`.execute(database.db);
  await sql`INSERT INTO leagues(id,name) VALUES (100,'synthetic-league')`.execute(database.db);
  await sql`INSERT INTO heroes(id,internal_name,localized_name) VALUES (1,'synthetic_hero','Synthetic hero')`.execute(database.db);
  await sql`INSERT INTO matches(id,started_at,patch_id,map_number,first_pick_side) VALUES (${query.matchId},${cutoffAt},1,3,'radiant')`.execute(database.db);
}, 30000);
afterEach(async () => { await database?.close(); });
async function seed() {
  const r = registry();
  const { id: _p, ...patch } = r.patches[0]!, { id: _d, ...draft } = r.draftRules[0]!, { id: _h, ...hero } = r.heroRules[0]!;
  const ids = [await writer.appendPatch(patch), await writer.appendDraftRule(draft), await writer.appendHeroRule(hero)];
  const contexts = new MatchContextRepository(database.db);
  for (const row of observations()) await contexts.append(withoutId(row));
  return { patch, draft, hero, ids };
}
it('round-trips evidence clocks, bigint IDs, revisions and native sides in a consistent snapshot', async () => {
  await seed();
  const result = await reader.readAsOf(query);
  expect(result.context).toMatchObject({ matchId: query.matchId, registryRevision: '3', dataRevision: '9',
    contextPolicyVersion: 'strict-asof-v2', radiantSlot: 'B', firstPickSlot: 'A', mapNumber: 2,
    patch: { value: '1' }, draftOrderVersion: 'synthetic-rule-v1', draftOrderValid: null });
  expect(result.context?.heroEligibility?.[0]?.value).toBe(true);
  expect(result.context?.heroEligibility?.[1]?.value).toBeNull();
  const snapshot = await writer.snapshot();
  expect(snapshot.patches[0]).toMatchObject(clocks);
  expect(result.context?.fieldEvidence.find(row => row.field === 'league_id')?.fact?.value).toBe('100');
  expect((await reader.readAsOf({ ...query, stage: 'pre_match' })).context)
    .toMatchObject({ firstPickSide: null, heroEligibility: null, draftOrderVersion: null });
});
it('does not promote mutable catalogs, completed match projections or legacy hero rules', async () => {
  await sql`INSERT INTO hero_availability_rules(hero_id,patch_id,league_id,allowed,valid_from,source,evidence_ref,known_at)
    VALUES (1,1,100,true,${before},'synthetic-legacy','synthetic:legacy',${before})`.execute(database.db);
  const result = await reader.readAsOf(query);
  expect(result.context).toMatchObject({ patch: { value: null }, mapNumber: null, radiantSlot: null,
    firstPickSide: null, heroEligibility: null, draftRule: { value: null } });
  expect((await writer.snapshot()).heroRules).toEqual([]);
});
it('concurrent identical evidence retries do not duplicate rows or increase registry revision', async () => {
  const seeded = await seed();
  const ids = await Promise.all(Array.from({ length: 5 }, () => writer.appendPatch(seeded.patch)));
  expect(new Set(ids)).toEqual(new Set([seeded.ids[0]]));
  await writer.appendDraftRule(seeded.draft); await writer.appendHeroRule(seeded.hero);
  expect((await writer.snapshot()).revision).toBe('3');
});
it('proofs cannot be updated/deleted, corrections append and late knowledge cannot rewrite history', async () => {
  const seeded = await seed();
  for (const table of ['patch_release_evidence', 'draft_rule_evidence', 'hero_availability_rules']) {
    await expect(sql`UPDATE ${sql.table(table)} SET source='changed'`.execute(database.db)).rejects.toThrow(/immutable/i);
    await expect(sql`DELETE FROM ${sql.table(table)}`.execute(database.db)).rejects.toThrow(/immutable/i);
  }
  await writer.appendHeroRule({ ...seeded.hero, allowed: false, knownAt: '2025-01-01T00:00:00.000Z' });
  expect((await reader.readAsOf(query)).context?.heroEligibility?.[0]?.value).toBe(true);
  expect((await writer.snapshot()).revision).toBe('4');
  await writer.appendHeroRule({ ...seeded.hero, allowed: false, evidenceRef: 'synthetic:conflicting-proof' });
  expect((await reader.readAsOf(query)).context?.heroEligibility?.[0]).toMatchObject({ value: null, reason: 'CONFLICT' });
});
it('validates evidence and catalog references before acceptance, including direct SQL clock bypass', async () => {
  const seeded = await seed();
  await expect(writer.appendHeroRule({ ...seeded.hero, heroId: 999 })).rejects.toThrow(/foreign key/i);
  await expect(writer.appendPatch({ ...seeded.patch, evidenceRef: ' ' })).rejects.toThrow();
  await expect(writer.appendDraftRule({ ...seeded.draft, lobbyType: -1 })).rejects.toThrow();
  await expect(sql`INSERT INTO draft_rule_evidence(patch_id,game_mode,lobby_type,rule_version,event_at,known_at,fetched_at,
    source,evidence_ref,review_state,evidence_sha256) VALUES (1,2,1,'synthetic',NULL,'2024-01-01T00:00:00.000001Z',
    '2026-01-01T00:00:00Z','synthetic','synthetic:proof','accepted',${'a'.repeat(64)})`.execute(database.db)).rejects.toThrow(/check constraint/i);
  await expect(sql`INSERT INTO hero_availability_rules(hero_id,allowed,valid_from,source,evidence_ref,known_at,
    fetched_at,review_state,evidence_sha256) VALUES (1,true,${before},'synthetic','synthetic:proof','2027-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z','accepted',${'b'.repeat(64)})`.execute(database.db)).rejects.toThrow(/ck_hero_rule_evidence/);
});
it('preserves source-context rejection for unknown maps, conflicts and post-start cutoff', async () => {
  expect((await reader.readAsOf({ ...query, matchId: '777' })).reason).toBe('MAP_NOT_FOUND');
  expect((await reader.readAsOf({ ...query, cutoffAt: '2024-01-01T12:00:00.001Z' })).reason).toBe('CUTOFF_AFTER_MAP_START');
  await sql`UPDATE matches SET ingest_state='conflict' WHERE id=${query.matchId}`.execute(database.db);
  expect((await reader.readAsOf(query)).reason).toBe('MAP_CONFLICT');
});
