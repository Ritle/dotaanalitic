import { ContextObservationSchema, IdentityTimeSchema, ReadinessRequestSchema, ReadinessFieldSchema,
  type ContextFact, type GameRegistry, type ReadinessField, type ReadinessRequest, type StoredContextObservation } from '@dota/contracts';
import { canonicalContextJson, CONTEXT_POLICY_VERSION } from './temporal.js';
import { resolvePatchAt } from './game-context.js';
import { LINEUP_POLICY_VERSION } from './identity.js';

export const READINESS_POLICY_VERSION = 'context-availability-v1';
type Availability = StoredContextObservation['availability'];
type Fact = ContextFact | { field: 'patch'; value: string };
type Proof = { id: string; availability: Availability; knownAt: string | null; eventAt: string | null;
  fetchedAt: string; recordedAt: string | null; evidenceRef: string | null; provider: string; reviewState: string;
  earliestStage: StoredContextObservation['earliestStage'] | null; eligible: boolean; reasons: string[] };
type FieldResult = { field: ReadinessField; status: 'available' | 'unavailable' | 'not_applicable';
  fact: Fact | null; availability: Availability | null; assumed: boolean; reasons: string[]; evidence: Proof[] };
const ids = (a: { id: string }, b: { id: string }) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
const draftFacts = ['heroes','first_pick_side','draft_order_version'];

/** Availability of current-map context only. No histories, targets, feature vectors or model eligibility. */
export function assessContextReadiness(input: readonly StoredContextObservation[], registry: GameRegistry,
  existingPlayerIds: readonly string[], startedAt: string, completedAt: string | null, request: ReadinessRequest) {
  const parsed = ReadinessRequestSchema.parse(request);
  const query = { ...parsed, requiredFacts: [...parsed.requiredFacts].sort(), assumedFacts: [...parsed.assumedFacts].sort() };
  IdentityTimeSchema.parse(startedAt); if (completedAt !== null) IdentityTimeSchema.parse(completedAt);
  if (query.cutoffAt > startedAt) throw new Error('readiness_cutoff_after_start');
  const conditional = query.cohort === 'conditional_lineup_reconstructed';
  const blockers = conditional && (completedAt === null || completedAt <= startedAt || completedAt > query.snapshotAt) ? ['MAP_NOT_COMPLETED_AT_SNAPSHOT'] : [];
  const observations = input.map(({ id, recordedAt = null, ...row }) => ({ id,
    recordedAt: recordedAt === null ? null : IdentityTimeSchema.parse(recordedAt), ...ContextObservationSchema.parse(row) }))
    .filter(row => row.matchId === query.matchId).sort(ids);
  const knownPlayers = new Set(existingPlayerIds);
  const fields = ReadinessFieldSchema.options.map<FieldResult>(field => {
    if (query.stage === 'pre_match' && draftFacts.includes(field)) return {
      field, status: 'not_applicable', fact: null, availability: null, assumed: false, reasons: ['STAGE_UNAVAILABLE'], evidence: [] };
    if (field === 'patch') {
      const patches = registry.patches.filter(row => row.fetchedAt <= query.snapshotAt);
      const strict = resolvePatchAt(patches, startedAt, query.cutoffAt);
      const retrospective = resolvePatchAt(patches, startedAt, query.snapshotAt);
      const assume = strict.value === null && strict.reason !== 'CONFLICT' && conditional && query.assumedFacts.includes('patch');
      const selected = assume ? retrospective : strict;
      const evidence: Proof[] = registry.patches.filter(row => row.releasedAt <= startedAt).sort(ids).map(row => ({
        id: 'patch:' + row.id, availability: row.knownAt <= query.cutoffAt && (row.eventAt === null || row.eventAt <= query.cutoffAt) ? 'verified_asof' : 'retrospective_fact',
        knownAt: row.knownAt, eventAt: row.eventAt, fetchedAt: row.fetchedAt, recordedAt: null, evidenceRef: row.evidenceRef,
        provider: row.source, reviewState: row.reviewState, earliestStage: null,
        eligible: selected.value !== null && selected.evidenceIds.includes(row.id),
        reasons: row.fetchedAt > query.snapshotAt ? ['FUTURE_FETCH'] : [] }));
      return { field, status: selected.value === null ? 'unavailable' : 'available',
        fact: selected.value === null ? null : { field: 'patch', value: selected.value },
        availability: selected.value === null ? null : assume ? 'retrospective_fact' : 'verified_asof',
        assumed: selected.value !== null && assume, reasons: selected.reason ? [selected.reason] : [], evidence };
    }
    const rows = observations.filter(row => row.fact.field === field);
    const eligible: StoredContextObservation[] = [];
    const evidence: Proof[] = rows.map(row => {
      const reasons: string[] = [];
      if (row.fetchedAt > query.snapshotAt) reasons.push('FUTURE_FETCH');
      if (!['accepted','conflict'].includes(row.reviewState)) reasons.push('UNREVIEWED');
      if (row.evidenceRef === null) reasons.push('MISSING_EVIDENCE_REF');
      const reconstruct = row.availability === 'retrospective_fact' && conditional && query.assumedFacts.includes(field);
      const owner = row.availability === 'user_asserted_asof' && query.cohort === 'owner_asserted_asof' && row.provider === 'owner';
      if (row.availability !== 'verified_asof' && !owner && !reconstruct) reasons.push('COHORT_EXCLUDED');
      if (!reconstruct) {
        if (row.knownAt === null || row.knownAt > query.cutoffAt) reasons.push('UNKNOWN_OR_LATE_KNOWLEDGE');
        if (row.eventAt !== null && row.eventAt > query.cutoffAt) reasons.push('FUTURE_EVENT');
        if (row.earliestStage === 'post_match' || query.stage === 'pre_match' && row.earliestStage !== 'pre_match') reasons.push('STAGE_UNAVAILABLE');
      }
      // Late archives can prove public facts; a later owner assertion cannot prove an earlier live entry.
      if (row.availability === 'user_asserted_asof' && (row.fetchedAt > query.cutoffAt || row.recordedAt === null || row.recordedAt > query.cutoffAt))
        reasons.push('OWNER_ASSERTION_RECORDING_UNPROVEN_OR_LATE');
      if (!reasons.length) eligible.push(row);
      return { id: row.id, availability: row.availability, knownAt: row.knownAt, eventAt: row.eventAt,
        fetchedAt: row.fetchedAt, recordedAt: row.recordedAt, evidenceRef: row.evidenceRef, provider: row.provider, reviewState: row.reviewState,
        earliestStage: row.earliestStage, eligible: !reasons.length, reasons };
    });
    const conflict = eligible.some(row => row.reviewState === 'conflict') || new Set(eligible.map(row => canonicalContextJson(row.fact))).size > 1;
    const selected = eligible.find(row => row.availability === 'verified_asof') ?? eligible[0];
    const available = !conflict && selected !== undefined && selected.fact.value !== null;
    return { field, status: available ? 'available' : 'unavailable', fact: available ? selected.fact : null,
      availability: available ? selected.availability : null, assumed: available && selected.availability === 'retrospective_fact',
      reasons: conflict ? ['CONFLICT'] : available ? [] : rows.length ? ['NO_ELIGIBLE_FACT'] : ['MISSING'], evidence };
  });
  const invalidate = (field: FieldResult, reason: string) => {
    field.status = 'unavailable'; field.fact = null; field.availability = null; field.assumed = false; field.reasons.push(reason);
  };
  const lineup = fields.find(row => row.field === 'lineup')!;
  const members = lineup.fact?.field === 'lineup' ? lineup.fact.value : null;
  const fullLineup = members?.length === 10 && members.every(row => row.playerId !== null && knownPlayers.has(row.playerId));
  if (lineup.status === 'available' && !fullLineup) invalidate(lineup, 'INCOMPLETE_OR_UNKNOWN_LINEUP');
  for (const field of fields) {
    if (field.fact?.field === 'heroes' && field.fact.value?.length !== 10) invalidate(field, 'TEN_DISTINCT_HEROES_REQUIRED');
    if (field.fact?.field === 'teams' && (!field.fact.value?.radiantTeamId || !field.fact.value.direTeamId)) invalidate(field, 'BOTH_TEAMS_REQUIRED');
    if (field.fact?.field === 'roles') {
      const roles = field.fact.value;
      const valid = lineup.status === 'available' && roles?.length === 10 && roles.every(role => role.rolePos !== null &&
        role.basis === 'confirmed' && (role.confidence === null || role.confidence === 1) &&
        members?.some(member => member.playerSlot === role.playerSlot && member.playerId === role.playerId)) &&
        [0,128].every(side => new Set(roles.filter(role => side === 0 ? role.playerSlot < 128 : role.playerSlot >= 128).map(role => role.rolePos)).size === 5);
      if (!valid) invalidate(field, 'ROLES_UNCONFIRMED_OR_LINEUP_MISMATCH');
    }
  }
  const missingFacts = query.requiredFacts.filter(name => fields.find(field => field.field === name)?.status !== 'available');
  const policyKey = canonicalContextJson({ version: READINESS_POLICY_VERSION, stage: query.stage, cohort: query.cohort,
    requiredFacts: [...query.requiredFacts].sort(), assumedFacts: [...query.assumedFacts].sort() });
  return { ...query, startedAt, scope: 'context_availability_only' as const, policyVersion: READINESS_POLICY_VERSION,
    contextPolicyVersion: CONTEXT_POLICY_VERSION, lineupPolicyVersion: LINEUP_POLICY_VERSION, registryRevision: registry.revision, policyKey,
    status: missingFacts.length === 0 && blockers.length === 0 ? 'ready' as const : 'incomplete' as const,
    evidenceBasis: conditional ? 'retrospective_conditional' as const : query.cohort === 'owner_asserted_asof' ? 'owner_asserted' as const : 'verified_historical' as const,
    trainingEligibility: 'not_assessed' as const, predictionEligibility: 'not_assessed' as const,
    missingFacts, blockers, appliedAssumptions: fields.filter(field => field.assumed).map(field => field.field), fields };
}

/** Never pool cohort policies; one canonical map remains one observation. */
export function selectReadyMapIds(reports: readonly ReturnType<typeof assessContextReadiness>[], expectedPolicyKey: string) {
  const snapshots = new Map<string, string>(), maps = new Set<string>();
  for (const report of reports) {
    if (report.policyKey !== expectedPolicyKey) throw new Error('readiness_cohort_policy_mismatch');
    const digest = canonicalContextJson(report);
    if (snapshots.has(report.matchId) && snapshots.get(report.matchId) !== digest) throw new Error('readiness_map_snapshot_conflict');
    snapshots.set(report.matchId, digest);
    if (report.status === 'ready') maps.add(report.matchId);
  }
  return [...maps].sort((a,b) => BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
}
