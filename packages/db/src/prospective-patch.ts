import { createHash } from 'node:crypto';
import { ProspectivePatchInputSchema, type ProspectivePatchEvidence } from '@dota/contracts';

export const PROSPECTIVE_PATCH_POLICY = 'prospective-patch-preparation-v1';
type ObservedStatus = 'observed' | 'unknown' | 'stale' | 'conflict';
type ConditionStatus = 'not_requested' | 'conditional' | 'unavailable';

/** Pure preparation only. Never replaces resolvePatchAt or grants model eligibility. */
export function prepareProspectivePatchContext(input: unknown) {
  const parsed = ProspectivePatchInputSchema.parse(input);
  const { request } = parsed;
  // This cohort reproduces information locally recorded AND reviewed by cutoff.
  // Late archive reconstruction is a separate historical policy, not an exception here.
  const visible = parsed.evidence.filter(row => row.reviewedAt <= request.cutoffAt &&
    (row.scope.kind === 'game' || row.scope.leagueId === request.target.leagueId));
  const unique = new Map<string, ProspectivePatchEvidence>();
  for (const row of visible) {
    const previous = unique.get(row.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row))
      throw new Error('prospective_patch_evidence_id_conflict');
    unique.set(row.id, row);
  }
  const evidence = [...unique.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
  const reviewed = evidence.filter(row => row.reviewState === 'accepted' || row.reviewState === 'conflict');
  const active = reviewed.filter(row => row.kind === 'active_version');
  const fresh = active.filter(row => Date.parse(request.cutoffAt) - Date.parse(row.eventAt) <= request.freshness.maxAgeSeconds * 1000);
  const labels = new Set(fresh.map(row => row.patchLabel));
  const status: ObservedStatus = fresh.some(row => row.reviewState === 'conflict') || labels.size > 1 ? 'conflict' :
    fresh.length ? 'observed' : active.length ? 'stale' : 'unknown';
  const patchLabel = status === 'observed' ? fresh[0]!.patchLabel : null;
  const observed = { status, patchLabel, evidenceIds: fresh.map(row => row.id),
    reasons: status === 'observed' ? [] : [`ACTIVE_VERSION_${status.toUpperCase()}`] };

  let conditionStatus: ConditionStatus = 'not_requested';
  const conditionReasons: string[] = [];
  if (request.assumption === 'same_as_observed') {
    if (patchLabel === null) conditionReasons.push('OBSERVED_PATCH_UNAVAILABLE');
    if (request.target.scheduledMapAt === null) conditionReasons.push('MAP_TIME_UNKNOWN');
    // No implicit latest-write-wins between sources. All fresh active observations
    // must agree; only transitions strictly before them are outside this horizon.
    const earliestObservation = fresh.reduce<string | null>((min, row) => min === null || row.eventAt < min ? row.eventAt : min, null);
    const blockingNotice = reviewed.some(row => row.kind === 'announced_transition' &&
      (row.effectiveAt === null ||
        ((earliestObservation === null || row.effectiveAt >= earliestObservation) &&
          (request.target.scheduledMapAt === null || row.effectiveAt <= request.target.scheduledMapAt))));
    if (blockingNotice) conditionReasons.push('PATCH_TRANSITION_BEFORE_MAP');
    conditionStatus = conditionReasons.length ? 'unavailable' : 'conditional';
  }
  const body = {
    schemaVersion: 1 as const, policyVersion: PROSPECTIVE_PATCH_POLICY,
    request, evidence, observed,
    condition: { status: conditionStatus, patchLabel: conditionStatus === 'conditional' ? patchLabel : null, reasons: conditionReasons },
    actualMapPatchLabel: null,
    prediction: { status: 'unavailable' as const, teamAWinProbability: null, reasons: ['PROSPECTIVE_PATCH_CONTEXT_NOT_MODEL_GATE'] },
    trainingReady: false as const, deployable: false as const
  };
  return { ...body, fingerprint: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}
