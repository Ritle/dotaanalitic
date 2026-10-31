import { ContextAsOfSchema, ContextObservationSchema, type ContextAsOf, type ContextField,
  type ContextFact, type StoredContextObservation } from '@dota/contracts';

export const CONTEXT_POLICY_VERSION = 'strict-asof-v2';
export const CONTEXT_FIELDS: readonly ContextField[] = ['league_id', 'game_mode', 'lobby_type', 'series_id', 'map_number', 'series_score_before',
  'teams', 'first_pick_side', 'draft_order_version', 'lineup', 'roles', 'heroes'];
type Reason = 'MISSING' | 'UNVERIFIED_AVAILABILITY' | 'UNREVIEWED' | 'LATE_KNOWLEDGE' |
  'FUTURE_EVENT' | 'STAGE_UNAVAILABLE' | 'BETWEEN_MAPS_UNSUPPORTED' | 'CONFLICT' | 'NULL_VALUE';
export type ContextResolution = {
  field: ContextField; fact: ContextFact | null; status: 'available' | 'unavailable';
  reasons: Reason[]; observationIds: string[];
};

// Canonicalize object keys and native slots, never infer a side/role from array position.
export function canonicalContextJson(value: unknown): string {
  function ordered(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(ordered).sort((a, b) => {
      if (a && b && typeof a === 'object' && typeof b === 'object' && 'playerSlot' in a && 'playerSlot' in b)
        return Number(a.playerSlot) - Number(b.playerSlot);
      return 0;
    });
    if (input !== null && typeof input === 'object') return Object.fromEntries(
      Object.entries(input).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => [key, ordered(item)]));
    return input;
  }
  return JSON.stringify(ordered(value));
}

/** Strict evidence policy only. No conditional/user-asserted cohort is silently enabled. */
export function resolveContextAsOf(observations: readonly StoredContextObservation[], request: ContextAsOf) {
  const query = ContextAsOfSchema.parse(request);
  const parsed = observations.map(({ id, recordedAt: _recordedAt, ...row }) => ({ id, ...ContextObservationSchema.parse(row) }));
  const relevant = parsed.filter(row => row.matchId === query.matchId);
  const fields = CONTEXT_FIELDS.map<ContextResolution>(field => {
    const rows = relevant.filter(row => row.fact.field === field);
    const reasons = new Set<Reason>();
    const eligible: StoredContextObservation[] = [];
    for (const row of rows) {
      if (field === 'series_score_before') { reasons.add('BETWEEN_MAPS_UNSUPPORTED'); continue; }
      if (row.availability !== 'verified_asof' || row.knownAt === null || row.evidenceRef === null) {
        reasons.add('UNVERIFIED_AVAILABILITY'); continue;
      }
      if (row.knownAt > query.cutoffAt) { reasons.add('LATE_KNOWLEDGE'); continue; }
      if (row.eventAt !== null && row.eventAt > query.cutoffAt) { reasons.add('FUTURE_EVENT'); continue; }
      if (row.earliestStage === 'post_match' || query.stage === 'pre_match' && row.earliestStage !== 'pre_match') {
        reasons.add('STAGE_UNAVAILABLE'); continue;
      }
      if (row.reviewState === 'conflict') { eligible.push(row); continue; }
      if (row.reviewState !== 'accepted') { reasons.add('UNREVIEWED'); continue; }
      eligible.push(row);
    }
    eligible.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
    const observationIds = eligible.map(row => row.id);
    const values = new Set(eligible.map(row => canonicalContextJson(row.fact)));
    const conflict = eligible.some(row => row.reviewState === 'conflict') || values.size > 1;
    if (conflict) return { field, fact: null, status: 'unavailable', reasons: ['CONFLICT'], observationIds };
    const fact = eligible[0]?.fact;
    if (fact && fact.value !== null) return { field, fact, status: 'available', reasons: [], observationIds };
    if (fact) reasons.add('NULL_VALUE');
    if (rows.length === 0) reasons.add('MISSING');
    return { field, fact: null, status: 'unavailable', reasons: [...reasons].sort(), observationIds };
  });
  return { ...query, policyVersion: CONTEXT_POLICY_VERSION, fields };
}

/** Temporal window only, NOT a substitute for pro/identity/outcome availability gates. */
export function isPriorCompletedMap(startedAt: string, endedAt: string | null, cutoffAt: string): boolean {
  const start = Date.parse(startedAt), end = endedAt === null ? NaN : Date.parse(endedAt), cutoff = Date.parse(cutoffAt);
  return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(cutoff) && start < cutoff && end > start && end <= cutoff;
}

export function sideToScenarioSlot(side: 'radiant' | 'dire' | null, radiantSlot: 'A' | 'B' | null): 'A' | 'B' | null {
  if (side === null || radiantSlot === null) return null;
  return side === 'radiant' ? radiantSlot : radiantSlot === 'A' ? 'B' : 'A';
}
