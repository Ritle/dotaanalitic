import { describe, expect, it } from 'vitest';
import { V1_FEATURE_PROFILE, type V1FeatureHistory, type V1FeatureScenario } from '@dota/contracts';
import { buildV1Features, createV1FeatureBuilder } from '../src/index.js';

const base = BigInt(Date.parse('2025-01-01T00:00:00.000Z')) * 1000n;
const at = (seconds: number) => (base + BigInt(seconds) * 1000000n).toString();
function fixture(n = 5) {
  const members = Array.from({ length: 10 }, (_, i) => ({ playerId: String(9007199254741000n + BigInt(i)), accountId: String(1000 + i) }));
  const history: V1FeatureHistory = { schemaVersion: 1, profile: V1_FEATURE_PROFILE, sourceFingerprint: 'a'.repeat(64),
    identityRevision: '1', snapshotAtUs: at(172800), warmupFromAtUs: at(0), syntheticOnly: true,
    identities: members.map(p => ({ observationId: 'synthetic:' + p.accountId, playerId: p.playerId,
      provider: 'opendota', externalAccountId: p.accountId, status: 'verified', eventAt: null, knownAt: null,
      fetchedAt: '2025-01-02T00:00:00.000Z', source: 'synthetic', evidenceRef: 'synthetic:' + p.accountId })),
    maps: Array.from({ length: n }, (_, i) => ({ matchId: String(i + 1), seriesKey: 'synthetic:' + i,
      startedAtUs: at((i + 1) * 1000), completedAtUs: at((i + 1) * 1000 + 100), isPro: true,
      teamA: members.slice(0, 5), teamB: members.slice(5), teamAWon: true, outcomeReceiptId: String(i + 1),
      payloadSha256: 'b'.repeat(64), fetchedAtUs: at(86400), labelVerifiedAtUs: at(172800), factClocks: [] })) };
  const scenario: V1FeatureScenario = { schemaVersion: 1, cutoffAtUs: at(180000), targetMatchId: null,
    teamA: members.slice(0, 5), teamB: members.slice(5), lineup: { basis: 'manual', source: 'synthetic:owner',
      selectedAtUs: at(172799), revision: '1' } };
  return { history, scenario };
}

describe('V1 shared strict completed-history Elo features', () => {
  it('matches a hand-computed five-map Elo trajectory; never exports a probability', () => {
    const { history, scenario } = fixture(), result = buildV1Features(history, scenario);
    let a = 1500, b = 1500;
    for (let i = 0; i < 5; i++) { const delta = 32 * (1 - 1 / (1 + 10 ** ((b - a) / 400))); a += delta; b -= delta; }
    expect(result.status).toBe('ready');
    expect(result.features!.teamAMeanElo).toBeCloseTo(a, 10);
    expect(result.features!.teamBMeanElo).toBeCloseTo(b, 10);
    expect(result.coverage).toEqual({ nRaw: 5, nEff: 5, minimumPlayerMaps: 5, playersWithHistory: 10, playersMeetingMinimum: 10 });
    expect(result.teamAWinProbability).toBeNull(); expect(result.deployable).toBe(false);
    expect(result.predictionStatus).toBe('unavailable');
  });
  it('returns null ratings and features for no observations, never displays the prior as experience', () => {
    const { history, scenario } = fixture(0), result = buildV1Features(history, scenario);
    expect(result.features).toBeNull(); expect(result.coverage.nRaw).toBe(0);
    expect(result.teamA.every(p => p.rating === null && p.maps === 0)).toBe(true);
    expect(result.reasons).toContain('INSUFFICIENT_PLAYER_HISTORY');
  });
  it('requires five completed maps for every player, while allowing cold-start rating updates', () => {
    const { history, scenario } = fixture(4), result = buildV1Features(history, scenario);
    expect(result.features).toBeNull(); expect(result.teamA[0]!.rating).toBeGreaterThan(1500);
    expect(result.coverage.minimumPlayerMaps).toBe(4);
  });
  it('swapping scenario A/B swaps means and negates the feature without assigning Radiant', () => {
    const { history, scenario } = fixture(), a = buildV1Features(history, scenario);
    const b = buildV1Features(history, { ...scenario, teamA: scenario.teamB, teamB: scenario.teamA });
    expect(b.features!.teamAMeanElo).toBe(a.features!.teamBMeanElo);
    expect(b.features!.eloDifference).toBe(-a.features!.eloDifference);
  });
  it('preserves ratings when historical sides and corresponding winners are reversed', () => {
    const { history, scenario } = fixture(), a = buildV1Features(history, scenario);
    for (const map of history.maps) { [map.teamA, map.teamB] = [map.teamB, map.teamA]; map.teamAWon = !map.teamAWon; }
    expect(buildV1Features(history, scenario).features!.eloDifference).toBeCloseTo(a.features!.eloDifference, 10);
  });
  it('is invariant to input/map/member/proof ordering and does not mutate caller data', () => {
    const { history, scenario } = fixture(), original = structuredClone({ history, scenario });
    const a = buildV1Features(history, scenario);
    expect({ history, scenario }).toEqual(original);
    history.maps.reverse(); history.identities.reverse(); scenario.teamA.reverse(); scenario.teamB.reverse();
    for (const map of history.maps) { map.teamA.reverse(); map.teamB.reverse(); }
    expect(buildV1Features(history, scenario)).toEqual(a);
  });
  it('does not consume ongoing, exact-cutoff, target or future outcomes', () => {
    const { history, scenario } = fixture(8);
    scenario.cutoffAtUs = at(6100); scenario.targetMatchId = '7';
    history.maps[6]!.startedAtUs = at(6100);
    scenario.lineup = { ...scenario.lineup, basis: 'actual_lineup_reconstructed' };
    const a = buildV1Features(history, scenario);
    expect(a.history.usedMatchIds).toEqual(['1', '2', '3', '4', '5']);
    for (const map of history.maps.slice(5)) map.teamAWon = false;
    expect(buildV1Features(history, scenario)).toEqual(a);
  });
  it('uses a strict boundary inside replay, including one microsecond after completion', () => {
    const { history, scenario } = fixture(2);
    history.maps[1]!.startedAtUs = history.maps[0]!.completedAtUs;
    expect(buildV1Features(history, scenario).teamA[0]!.rating).toBe(1532);
    history.maps[1]!.startedAtUs = (BigInt(history.maps[0]!.completedAtUs) + 1n).toString();
    expect(buildV1Features(history, scenario).teamA[0]!.rating).toBeLessThan(1532);
  });
  it('orders simultaneous completions numerically and freezes deltas at each start', () => {
    const { history, scenario } = fixture(3);
    history.maps[0]!.matchId = '9007199254741011'; history.maps[1]!.matchId = '9007199254741010';
    history.maps[0]!.completedAtUs = at(2500); history.maps[1]!.completedAtUs = at(2500);
    const result = buildV1Features(history, scenario);
    expect(result.history.usedMatchIds).toEqual(['9007199254741010', '9007199254741011', '3']);
    const expected = 1532 + 32 * (1 - 1 / (1 + 10 ** ((1468 - 1532) / 400)));
    expect(result.teamA[0]!.rating).toBeCloseTo(expected, 10);
  });
  it('retains personal history in a new mixed lineup without organization ratings or stand-in penalties', () => {
    const { history, scenario } = fixture(), before = buildV1Features(history, scenario);
    [scenario.teamA[0], scenario.teamB[0]] = [scenario.teamB[0]!, scenario.teamA[0]!];
    const after = buildV1Features(history, scenario);
    expect(after.teamB.find(p => p.playerId === before.teamA[0]!.playerId)!.rating).toBe(before.teamA[0]!.rating);
    expect(after.status).toBe('ready'); expect(after.features!.eloDifference).toBeCloseTo(before.features!.eloDifference * 0.6, 10);
  });
  it('rejects unknown scenario identity and excludes its whole known history series', () => {
    const { history, scenario } = fixture(); history.identities.shift();
    const result = buildV1Features(history, scenario);
    expect(result.reasons).toContain('IDENTITY_UNVERIFIED'); expect(result.features).toBeNull();
    expect(result.history.excludedMaps).toHaveLength(5); expect(result.coverage.nRaw).toBe(0);
  });
  it('does not merge conflicting numeric accounts or histories across accounts', () => {
    const { history, scenario } = fixture();
    history.identities.push({ ...history.identities[0]!, observationId: 'synthetic:conflict', playerId: '999' });
    expect(buildV1Features(history, scenario).reasons).toContain('IDENTITY_CONFLICT');
    history.identities.pop();
    history.identities.push({ ...history.identities[0]!, observationId: 'synthetic:other-account', externalAccountId: '1999' });
    expect(buildV1Features(history, scenario).reasons).toContain('CROSS_ACCOUNT_HISTORY_UNSUPPORTED');
  });
  it('honors rejected evidence and excludes identities fetched after the snapshot', () => {
    const { history, scenario } = fixture();
    history.identities.push({ ...history.identities[0]!, observationId: 'synthetic:rejected', status: 'rejected' });
    expect(buildV1Features(history, scenario).reasons).toContain('IDENTITY_CONFLICT');
    history.identities.pop(); history.identities[0]!.fetchedAt = '2025-01-04T00:00:00.000Z';
    expect(buildV1Features(history, scenario).reasons).toContain('IDENTITY_UNVERIFIED');
  });
  it('distinguishes reconstructed lineups from a manual selection made after start', () => {
    const { history, scenario } = fixture(); scenario.cutoffAtUs = at(7000);
    expect(buildV1Features(history, scenario).reasons).toContain('LINEUP_NOT_SELECTED_BEFORE_START');
    scenario.lineup.basis = 'actual_lineup_reconstructed';
    expect(buildV1Features(history, scenario).status).toBe('ready');
    scenario.lineup.selectedAtUs = at(172801);
    expect(buildV1Features(history, scenario).reasons).toContain('LINEUP_AFTER_SNAPSHOT');
  });
  it('rejects duplicate maps, duplicate players, invalid clocks, unverified pro and target post-start fields', () => {
    const { history, scenario } = fixture();
    expect(() => buildV1Features({ ...history, maps: [...history.maps, history.maps[0]] }, scenario)).toThrow('v1_duplicate_history_map');
    expect(() => buildV1Features(history, { ...scenario, teamB: scenario.teamA })).toThrow();
    expect(() => buildV1Features(history, { ...scenario, teamAWon: true })).toThrow();
    history.maps[0]!.isPro = false as true; expect(() => buildV1Features(history, scenario)).toThrow();
    history.maps[0]!.isPro = true; history.maps[0]!.completedAtUs = history.maps[0]!.startedAtUs;
    expect(() => buildV1Features(history, scenario)).toThrow();
  });
  it('rejects snapshot violations and an attempted target cutoff change', () => {
    const { history, scenario } = fixture();
    expect(() => buildV1Features(history, { ...scenario, targetMatchId: '1' })).toThrow('v1_target_cutoff_mismatch');
    history.maps[0]!.labelVerifiedAtUs = at(172801);
    expect(() => buildV1Features(history, scenario)).toThrow('v1_history_after_snapshot');
  });
  it('does not let an outside-warmup sibling silently enter history through its series', () => {
    const { history, scenario } = fixture(); history.warmupFromAtUs = at(1500);
    history.maps[1]!.seriesKey = history.maps[0]!.seriesKey;
    const result = buildV1Features(history, scenario);
    expect(result.history.usedMatchIds).toEqual(['3', '4', '5']);
    expect(result.history.excludedMaps[1]!.reasons).toContain('SERIES_HAS_INELIGIBLE_HISTORY');
  });
  it('uses identical immutable factory and single-call results for offline/runtime consumers', () => {
    const { history, scenario } = fixture(), builder = createV1FeatureBuilder(history);
    const expected = buildV1Features(history, scenario); history.maps[0]!.teamAWon = false;
    expect(builder(scenario)).toEqual(expected); expect(builder(scenario)).toEqual(expected);
  });
  it('does not retain mutable output references between scenarios', () => {
    const { history, scenario } = fixture(); history.identities.shift();
    const builder = createV1FeatureBuilder(history), first = builder(scenario), original = structuredClone(first);
    first.history.excludedMaps[0]!.reasons.push('caller-edit'); first.history.excludedMaps.length = 0;
    first.teamA[0]!.identityProofIds.push('caller-edit');
    expect(builder(scenario)).toEqual(original);
  });
});
