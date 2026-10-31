import { expect, it } from 'vitest';
import { PatchReleaseEvidenceSchema, HeroRuleEvidenceSchema, DraftRuleEvidenceSchema, GameContextRequestSchema,
  type GameContextRequest } from '@dota/contracts';
import { resolveContextAsOf } from '../src/temporal.js';
import { resolveGameContext } from '../src/game-context.js';
import { query, cutoffAt, before, after, clocks, registry, observations, observation } from './game-fixtures.js';

function resolve(r = registry(), rows = observations(), request: GameContextRequest = query) {
  const context = resolveContextAsOf(rows, { matchId: request.matchId, cutoffAt: request.cutoffAt, stage: request.stage });
  return resolveGameContext(context, cutoffAt, request, r);
}
it('uses native sides independently from scenario order and first pick; no BO3 or timeline assumptions', () => {
  const result = resolve();
  expect(result).toMatchObject({ radiantSlot: 'B', firstPickSide: 'dire', firstPickSlot: 'A', mapNumber: 2,
    seriesId: '123e4567-e89b-42d3-a456-426614174000', seriesScoreBefore: null, draftOrderVersion: 'synthetic-rule-v1', draftOrderValid: null });
  expect(result.heroEligibility?.[0]).toMatchObject({ value: true, evidenceIds: ['3'] });
  expect(result.heroEligibility?.[1]?.value).toBeNull();
  expect(resolve(registry(), observations(), { ...query, teamAId: '22', teamBId: '11' })).toMatchObject({ radiantSlot: 'A', firstPickSlot: 'B' });
});
it('empty evidence leaves unknown fields null; never manufactures a side, map number or hero list', () => {
  const result = resolve({ revision: '0', patches: [], draftRules: [], heroRules: [] }, []);
  expect(result).toMatchObject({ radiantSlot: null, firstPickSide: null, firstPickSlot: null, mapNumber: null,
    seriesId: null, heroEligibility: null, draftOrderVersion: null, patch: { value: null } });
});
it('pre-match cannot expose post-draft heroes, rule version or first pick', () => {
  const result = resolve(registry(), observations(), { ...query, stage: 'pre_match' });
  expect(result).toMatchObject({ heroEligibility: null, firstPickSide: null, firstPickSlot: null,
    draftOrderVersion: null, draftRule: { value: null }, draftOrderValid: null, patch: { value: '1' } });
});
it.each(['knownAt', 'eventAt'] as const)('late %s is excluded independently for patch, draft and hero proofs', clock => {
  for (const key of ['patches', 'draftRules', 'heroRules'] as const) {
    const r = registry(); r[key][0]![clock] = after;
    const result = resolve(r);
    expect(key === 'patches' ? result.patch.value : key === 'draftRules' ? result.draftRule.value : result.heroEligibility?.[0]?.value).toBeNull();
  }
});
it.each(['unverified', 'rejected'] as const)('ignores %s registry claims', reviewState => {
  const r = registry(); r.patches[0]!.reviewState = reviewState;
  expect(resolve(r).patch.value).toBeNull();
});
it('release boundary is inclusive and coverage end exclusive, without fallback to an old patch', () => {
  const r = registry(); r.patches.push({ ...r.patches[0]!, id: '4', patchId: '2', releasedAt: cutoffAt });
  expect(resolve(r).patch.value).toBe('2');
  r.patches[1]!.coverageUntil = '2024-01-01T12:00:00.001Z';
  expect(resolve(r).patch.value).toBe('2');
  r.patches[1]!.releasedAt = '2024-01-01T11:00:00.000Z'; r.patches[1]!.coverageUntil = cutoffAt;
  expect(resolve(r).patch).toMatchObject({ value: null, reason: 'PATCH_COVERAGE_GAP' });
});
it('conflicting same-time patch IDs or release timestamps for one patch fail closed', () => {
  const r = registry(); r.patches.push({ ...r.patches[0]!, id: '4', patchId: '2' });
  expect(resolve(r).patch.reason).toBe('CONFLICT');
  r.patches[1]!.patchId = '1'; r.patches[1]!.releasedAt = '2024-01-01T01:00:00.000Z';
  expect(resolve(r).patch.reason).toBe('CONFLICT');
  expect(resolve(r).patch.evidenceIds).toEqual(['1', '4']);
  r.patches = [{ ...r.patches[0]!, reviewState: 'conflict' }];
  expect(resolve(r).patch.reason).toBe('CONFLICT');
});
it.each(['game_mode', 'lobby_type', 'league_id'] as const)('missing %s never silently uses a common default', field => {
  const result = resolve(registry(), observations().filter(row => row.fact.field !== field));
  expect(field === 'league_id' ? result.heroEligibility?.[0]?.value : result.draftRule.value).toBeNull();
});
it('requires exact historical mode/lobby/patch version and rejects conflicting rules', () => {
  const r = registry(); r.draftRules[0]!.gameMode = 3;
  expect(resolve(r).draftOrderVersion).toBeNull();
  r.draftRules[0]!.gameMode = 2; r.draftRules[0]!.lobbyType = 7;
  expect(resolve(r).draftRule.value).toBeNull();
  r.draftRules[0]!.lobbyType = 1; r.draftRules[0]!.version = 'synthetic-v2';
  expect(resolve(r).warnings).toContain('DRAFT_VERSION_MISMATCH');
  expect(resolve(r).draftOrderVersion).toBeNull();
  r.draftRules.push({ ...r.draftRules[0]!, id: '5', version: 'synthetic-v3' });
  expect(resolve(r).draftRule.reason).toBe('CONFLICT');
});
it('hero rules enforce patch, league and half-open time bounds; missing rule is not allowed', () => {
  for (const changed of [{ patchId: '2' }, { leagueId: '101' }, { validFrom: after, validTo: null }, { validTo: cutoffAt }]) {
    const r = registry(); Object.assign(r.heroRules[0]!, changed);
    expect(resolve(r).heroEligibility?.[0]?.value).toBeNull();
  }
  const r = registry(); r.heroRules[0]!.validFrom = cutoffAt;
  expect(resolve(r).heroEligibility?.[0]?.value).toBe(true);
  r.heroRules[0]!.allowed = false;
  expect(resolve(r).heroEligibility?.[0]?.value).toBe(false);
  expect(resolve(r).warnings).toContain('HERO_INELIGIBLE');
});
it('explicit global rules apply but a contradictory tournament restriction is a conflict', () => {
  const r = registry(); r.heroRules[0]!.patchId = null; r.heroRules[0]!.leagueId = null;
  expect(resolve(r).heroEligibility?.[0]?.value).toBe(true);
  r.heroRules.push({ ...r.heroRules[0]!, id: '6', leagueId: '100', allowed: false });
  expect(resolve(r).heroEligibility?.[0]).toMatchObject({ value: null, reason: 'CONFLICT', evidenceIds: ['3', '6'] });
});
it('partial drafts and mismatched scenario teams remain explicit', () => {
  const rows = observations().filter(row => row.fact.field !== 'heroes');
  rows.push(observation({ field: 'heroes', value: [{ playerSlot: 128, heroId: 1 }] }, '99'));
  const result = resolve(registry(), rows, { ...query, teamAId: '33' });
  expect(result.radiantSlot).toBeNull(); expect(result.firstPickSlot).toBeNull();
  expect(result.heroEligibility).toHaveLength(1); expect(result.warnings).toContain('FULL_DRAFT_UNKNOWN');
});
it('evidence is immutable under resolution and input ordering does not affect decisions', () => {
  const r = registry(), rows = observations(), original = JSON.stringify({ r, rows });
  const result = resolve(r, rows);
  expect(resolve(r, [...rows].reverse())).toEqual(result);
  expect(JSON.stringify({ r, rows })).toBe(original);
});
it('rejects invalid clocks, IDs, horizons and request snapshot mismatch', () => {
  expect(() => GameContextRequestSchema.parse({ ...query, teamAId: query.teamBId })).toThrow();
  const { id: _id, ...patch } = registry().patches[0]!;
  expect(() => PatchReleaseEvidenceSchema.parse({ ...patch, coverageUntil: before })).toThrow();
  expect(() => PatchReleaseEvidenceSchema.parse({ ...patch, knownAt: '2027-01-01T00:00:00.000Z' })).toThrow();
  expect(() => DraftRuleEvidenceSchema.parse({ ...clocks, patchId: '0', gameMode: 2, lobbyType: 1, version: 'v1' })).toThrow();
  expect(() => HeroRuleEvidenceSchema.parse({ ...clocks, heroId: 1, patchId: null, leagueId: null, allowed: true, validFrom: after, validTo: before })).toThrow();
  const context = resolveContextAsOf([], { matchId: query.matchId, cutoffAt, stage: 'pre_match' });
  expect(() => resolveGameContext(context, cutoffAt, query, registry())).toThrow(/snapshot_mismatch/);
});
