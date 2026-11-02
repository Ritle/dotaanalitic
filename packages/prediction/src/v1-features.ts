import { createHash } from 'node:crypto';
import { V1FeatureHistorySchema, V1FeatureScenarioSchema, V1_FEATURE_PROFILE,
  type V1FeatureScenario } from '@dota/contracts';

export const V1_FEATURE_POLICY = Object.freeze({
  version: V1_FEATURE_PROFILE, initialRating: 1500, k: 32, scale: 400, minCompletedProMapsPerPlayer: 5,
  identity: 'current_verified_same_numeric_account', crossAccountMerges: 'unsupported',
  availability: 'event_time_assumed', cutoff: 'completed_at_strictly_before_target_start',
  update: 'start_frozen_equal_delta_applied_at_completion',
  completionOrder: 'completed_at_then_numeric_match_id', missingHistory: 'unavailable',
  validation: 'unvalidated'
} as const);

const cmp = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const textCmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const mean = (values: readonly number[]) => values.reduce((sum, n) => sum + n, 0) / values.length;
const timestampUs = (value: string) => BigInt(Date.parse(value)) * 1000n;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value)
    .sort(([a], [b]) => textCmp(a, b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const assertUnique = (values: string[], reason: string) => {
  if (new Set(values).size !== values.length) throw Error(reason);
};
type State = { rating: number; maps: number };
type Member = V1FeatureScenario['teamA'][number];

/** Server-side pure factory. No database, clock, provider, outcome scoring or active-model lookup. */
export function createV1FeatureBuilder(historyInput: unknown) {
  const history = V1FeatureHistorySchema.parse(historyInput);
  const snapshot = BigInt(history.snapshotAtUs), warmup = BigInt(history.warmupFromAtUs);
  assertUnique(history.maps.map(m => m.matchId), 'v1_duplicate_history_map');
  assertUnique(history.identities.map(i => i.observationId), 'v1_duplicate_identity_evidence');
  if (history.maps.some(m => BigInt(m.labelVerifiedAtUs) > snapshot || m.factClocks.some(f =>
    [f.eventAtUs, f.knownAtUs, f.fetchedAtUs, f.recordedAtUs].some(t => t !== null && BigInt(t) > snapshot)))) {
    throw Error('v1_history_after_snapshot');
  }
  const evidence = history.identities.filter(i => timestampUs(i.fetchedAt) <= snapshot &&
    (i.knownAt === null || timestampUs(i.knownAt) <= snapshot) && (i.eventAt === null || timestampUs(i.eventAt) <= snapshot));
  const byAccount = new Map<string, typeof evidence>(), accountsByPlayer = new Map<string, Set<string>>();
  for (const row of evidence) {
    const rows = byAccount.get(row.externalAccountId) ?? []; rows.push(row); byAccount.set(row.externalAccountId, rows);
    if (row.status === 'verified') {
      const accounts = accountsByPlayer.get(row.playerId) ?? new Set<string>();
      accounts.add(row.externalAccountId); accountsByPlayer.set(row.playerId, accounts);
    }
  }
  const identity = (member: Member) => {
    const rows = (byAccount.get(member.accountId) ?? []).filter(i => i.status !== 'provisional' && i.evidenceRef !== null);
    const verified = rows.filter(i => i.status === 'verified'), ids = new Set(verified.map(i => i.playerId));
    const conflict = ids.size > 1 || rows.some(i => i.status === 'rejected' && ids.has(i.playerId));
    const reason = conflict ? 'IDENTITY_CONFLICT' : !ids.has(member.playerId) ? 'IDENTITY_UNVERIFIED' :
      (accountsByPlayer.get(member.playerId)?.size ?? 0) > 1 ? 'CROSS_ACCOUNT_HISTORY_UNSUPPORTED' : null;
    return { reason, proofIds: verified.filter(i => i.playerId === member.playerId).map(i => i.observationId).sort(textCmp) };
  };
  const assessed = history.maps.map(map => ({ map, reasons: [...new Set([...map.teamA, ...map.teamB]
    .flatMap(p => identity(p).reason ?? []))] }));
  const badSeries = new Set(assessed.filter(r => r.reasons.length > 0 || BigInt(r.map.startedAtUs) < warmup).map(r => r.map.seriesKey));
  const exclusions = assessed.flatMap(({ map, reasons }) => {
    if (BigInt(map.startedAtUs) < warmup) reasons.push('BEFORE_WARMUP');
    if (badSeries.has(map.seriesKey)) reasons.push('SERIES_HAS_INELIGIBLE_HISTORY');
    return reasons.length ? [{ matchId: map.matchId, reasons: [...new Set(reasons)].sort() }] : [];
  }).sort((a, b) => cmp(a.matchId, b.matchId));
  const excluded = new Set(exclusions.map(r => r.matchId));
  const ordered = history.maps.filter(m => !excluded.has(m.matchId))
    .sort((a, b) => cmp(a.startedAtUs, b.startedAtUs) || cmp(a.matchId, b.matchId));

  return (scenarioInput: unknown) => {
    const scenario = V1FeatureScenarioSchema.parse(scenarioInput), cutoff = BigInt(scenario.cutoffAtUs);
    const members = [...scenario.teamA, ...scenario.teamB];
    const reasons = [...new Set(members.flatMap(p => identity(p).reason ?? []))];
    if (BigInt(scenario.lineup.selectedAtUs) > snapshot) reasons.push('LINEUP_AFTER_SNAPSHOT');
    if (scenario.lineup.basis !== 'actual_lineup_reconstructed' && BigInt(scenario.lineup.selectedAtUs) >= cutoff)
      reasons.push('LINEUP_NOT_SELECTED_BEFORE_START');
    if (cutoff <= warmup) reasons.push('NO_HISTORY_WINDOW');
    const target = history.maps.find(m => m.matchId === scenario.targetMatchId);
    if (target && target.startedAtUs !== scenario.cutoffAtUs) throw Error('v1_target_cutoff_mismatch');

    // Do not even consume the target, ongoing or future outcomes in this replay.
    const maps = ordered.filter(m => m.matchId !== scenario.targetMatchId &&
      BigInt(m.startedAtUs) < cutoff && BigInt(m.completedAtUs) < cutoff);
    const completed = [...maps].sort((a, b) => cmp(a.completedAtUs, b.completedAtUs) || cmp(a.matchId, b.matchId));
    const states = new Map<string, State>(), deltas = new Map<string, number>();
    const state = (id: string): State => states.get(id) ?? { rating: V1_FEATURE_POLICY.initialRating, maps: 0 };
    const sorted = (players: Member[]) => [...players].sort((a, b) => cmp(a.playerId, b.playerId));
    let cursor = 0;
    const applyBefore = (at: bigint) => {
      while (cursor < completed.length && BigInt(completed[cursor]!.completedAtUs) < at) {
        const map = completed[cursor++]!, delta = deltas.get(map.matchId);
        if (delta === undefined) throw Error('v1_replay_order_invalid');
        for (const [players, sign] of [[map.teamA, 1], [map.teamB, -1]] as const) for (const player of players) {
          const prior = state(player.playerId);
          states.set(player.playerId, { rating: prior.rating + sign * delta, maps: prior.maps + 1 });
        }
      }
    };
    for (const map of maps) {
      applyBefore(BigInt(map.startedAtUs));
      const a = mean(sorted(map.teamA).map(p => state(p.playerId).rating));
      const b = mean(sorted(map.teamB).map(p => state(p.playerId).rating));
      const expected = 1 / (1 + 10 ** ((b - a) / V1_FEATURE_POLICY.scale));
      deltas.set(map.matchId, V1_FEATURE_POLICY.k * (Number(map.teamAWon) - expected));
    }
    applyBefore(cutoff);
    const side = (players: Member[]) => sorted(players).map(player => {
      const current = state(player.playerId), proof = identity(player);
      // Internal cold-start prior is never displayed as observed experience.
      return { ...player, maps: current.maps, rating: current.maps === 0 || proof.reason !== null ? null : current.rating,
        identityProofIds: proof.proofIds, reason: proof.reason };
    });
    const teamA = side(scenario.teamA), teamB = side(scenario.teamB), players = [...teamA, ...teamB];
    if (players.some(p => p.maps < V1_FEATURE_POLICY.minCompletedProMapsPerPlayer)) reasons.push('INSUFFICIENT_PLAYER_HISTORY');
    const uniqueReasons = [...new Set(reasons)].sort();
    const features = uniqueReasons.length ? null : {
      teamAMeanElo: mean(teamA.map(p => p.rating!)), teamBMeanElo: mean(teamB.map(p => p.rating!)),
      eloDifference: mean(teamA.map(p => p.rating!)) - mean(teamB.map(p => p.rating!))
    };
    const normalizedScenario = { ...scenario, teamA: sorted(scenario.teamA), teamB: sorted(scenario.teamB) };
    const result = {
      schemaVersion: 1 as const, featureSchemaVersion: V1_FEATURE_PROFILE, policy: V1_FEATURE_POLICY,
      status: features === null ? 'unavailable' as const : 'ready' as const, reasons: uniqueReasons, features,
      scenario: normalizedScenario, teamA, teamB,
      coverage: { nRaw: maps.length, nEff: maps.length, minimumPlayerMaps: Math.min(...players.map(p => p.maps)),
        playersWithHistory: players.filter(p => p.maps > 0).length,
        playersMeetingMinimum: players.filter(p => p.maps >= V1_FEATURE_POLICY.minCompletedProMapsPerPlayer).length },
      history: { sourceFingerprint: history.sourceFingerprint, identityRevision: history.identityRevision,
        snapshotAtUs: history.snapshotAtUs, warmupFromAtUs: history.warmupFromAtUs,
        usedMatchIds: completed.map(m => m.matchId),
        excludedMaps: exclusions.map(row => ({ ...row, reasons: [...row.reasons] })) },
      assumptions: ['EVENT_TIME_OUTCOME_AVAILABILITY_ASSUMED', 'CURRENT_SAME_ACCOUNT_IDENTITIES',
        'HISTORY_LIMITED_TO_SUPPLIED_ELIGIBLE_INVENTORY', 'REMOTE_COMPLETENESS_UNKNOWN'],
      evaluationBasis: 'conditional_on_selected_lineup' as const, syntheticOnly: history.syntheticOnly,
      predictionStatus: 'unavailable' as const, teamAWinProbability: null, deployable: false as const
    };
    return { ...result, fingerprint: hash(result) };
  };
}

/** Same entry point for offline rows and future runtime scenarios. */
export function buildV1Features(history: unknown, scenario: unknown) {
  return createV1FeatureBuilder(history)(scenario);
}
