import { createHash } from 'node:crypto';
import { ELO_POLICY } from '@dota/analytics';
import { ResearchDiscoverySchema, ResearchEloExportSchema, ResearchPlanRequestSchema } from '@dota/contracts';
import { canonicalContextJson } from './temporal.js';
const hash = (v: unknown) => createHash('sha256').update(canonicalContextJson(v)).digest('hex');
const us = (v: string) => BigInt(Date.parse(v)) * 1000n;
const idOrder = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;

/** Preregisters selection rules. Discovery rows are candidates, never verified training examples. */
export function planResearchElo(requestInput: unknown, priorInput: unknown, discoveryInput: unknown, registeredAt: string) {
  const request = ResearchPlanRequestSchema.parse(requestInput), discovery = ResearchDiscoverySchema.parse(discoveryInput);
  const { fingerprint: priorFingerprint, ...prior } = ResearchEloExportSchema.parse(priorInput);
  if (hash(prior) !== priorFingerprint) throw new Error('prior_export_fingerprint_mismatch');
  if (canonicalContextJson(prior.policy) !== canonicalContextJson(ELO_POLICY)) throw new Error('prior_policy_mismatch');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(registeredAt) ||
    !Number.isFinite(Date.parse(registeredAt)) || new Date(registeredAt).toISOString() !== registeredAt ||
    registeredAt >= request.holdoutFromAt || prior.request.toAt > registeredAt || prior.request.snapshotAt > registeredAt) {
    throw new Error('registration_must_precede_holdout');
  }
  if (new Set(prior.candidates.map(m => m.matchId)).size !== prior.candidates.length) throw new Error('duplicate_prior_map');
  // A future holdout must not contain any previously inspected map, including previously excluded candidates.
  if (prior.candidates.some(m => BigInt(m.startedAtUs) >= us(request.holdoutFromAt))) throw new Error('prior_map_in_future_holdout');
  const priorKeys = new Set(prior.aliases.filter(a => a.provider && a.providerSeriesId).map(a => `${a.provider}:${a.providerSeriesId}`));
  const priorIds = new Set(prior.candidates.map(m => m.matchId));
  const catalogue = discovery.selection_catalog;
  if (catalogue.source_evidence.endpoint !== '/leagues' || catalogue.source_evidence.fetched_at > registeredAt) throw new Error('catalogue_source_invalid');
  const selected = new Set(request.warmupLeagueIds);
  for (const id of selected) {
    const matches = discovery.cohorts.filter(c => c.league_id === id), entries = catalogue.selected_leagues.filter(l => l.leagueid === id);
    if (matches.length !== 1 || entries.length !== 1 || !['professional', 'premium'].includes(entries[0]!.tier) || entries[0]!.tier !== matches[0]!.tier) throw new Error('warmup_league_unverified');
  }
  const rows = discovery.cohorts.flatMap(c => {
    if (c.source_evidence.endpoint !== `/leagues/${c.league_id}/matches` || c.source_evidence.fetched_at > registeredAt ||
      c.matches.some(m => m.leagueid !== c.league_id)) throw new Error('discovery_source_invalid');
    return c.matches.map(m => ({ matchId: m.match_id, leagueId: m.leagueid, startedAt: new Date(m.start_time * 1000).toISOString(),
      seriesKey: m.series_id === null ? null : `opendota:${m.series_id}`,
      teamPair: m.radiant_team_id && m.dire_team_id && m.radiant_team_id !== m.dire_team_id ?
        [m.radiant_team_id, m.dire_team_id].sort(idOrder).join(':') : null }));
  });
  if (new Set(rows.map(m => m.matchId)).size !== rows.length) throw new Error('duplicate_discovery_map');
  const selectedRows = rows.filter(m => selected.has(m.leagueId));
  if (selectedRows.length > request.maxWarmupCandidates) throw new Error('warmup_inventory_limit');
  const assessments = selectedRows.map(m => {
    const siblings = m.seriesKey === null ? [] : rows.filter(s => s.seriesKey === m.seriesKey);
    const reasons: string[] = [];
    if (m.seriesKey === null) reasons.push('SERIES_UNKNOWN');
    if (siblings.some(s => s.teamPair === null) || new Set(siblings.map(s => s.teamPair)).size > 1) reasons.push('SERIES_ORGANIZATIONS_INVALID');
    if (siblings.some(s => !selected.has(s.leagueId))) reasons.push('SERIES_OUTSIDE_SELECTED_LEAGUES');
    if ([m, ...siblings].some(s => s.startedAt < request.warmupFromAt || s.startedAt >= request.holdoutFromAt)) reasons.push('SERIES_OUTSIDE_WARMUP');
    if ([m, ...siblings].some(s => priorIds.has(s.matchId) || s.seriesKey !== null && priorKeys.has(s.seriesKey))) reasons.push('SERIES_ALREADY_IN_PRIOR_EXPORT');
    return { matchId: m.matchId, leagueId: m.leagueId, startedAt: m.startedAt, seriesKey: m.seriesKey,
      action: reasons.length ? 'excluded' as const : 'fetch_and_verify' as const, reasons };
  }).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || idOrder(a.matchId, b.matchId));
  const candidates = assessments.filter(m => m.action === 'fetch_and_verify');
  const body = { schemaVersion: 1, format: 'research-elo-plan-v1', registeredAt, request,
    cohort: prior.cohort, eloPolicy: ELO_POLICY, priorExportFingerprint: priorFingerprint,
    reviewedMaps: prior.candidates.map(m => ({ matchId: m.matchId, startedAtUs: m.startedAtUs })).sort((a, b) => idOrder(a.matchId, b.matchId)),
    reviewedSeriesKeys: [...priorKeys].sort(),
    sourceEvidence: { catalogue: catalogue.source_evidence, warmup: discovery.cohorts.filter(c => selected.has(c.league_id))
      .map(c => ({ leagueId: c.league_id, ...c.source_evidence })).sort((a, b) => idOrder(a.leagueId, b.leagueId)) },
    warmup: { existingReviewedMaps: prior.candidates.length, discoveredMaps: assessments.length,
      candidateMaps: candidates.length, candidateSeries: new Set(candidates.map(m => m.seriesKey)).size,
      excludedMaps: assessments.length - candidates.length, assessments, verifiedNewMaps: 0 },
    holdout: { status: 'not_started', candidateMaps: null, eligibleMaps: null, metrics: null,
      selection: 'all_observed_verified_pro_maps_in_fixed_window', provider: 'opendota',
      seriesPolicy: 'whole_known_series_exclude_boundary_crossing_unknown_conflicting_and_overlapping',
      replayPolicy: 'event-time-prequential-series-v1', retuning: 'forbidden_on_this_holdout',
      stoppingRule: 'fixed_window_no_extension_based_on_metrics_or_sample_count',
      earlyScoring: 'forbidden_before_evaluationNotBefore', evaluationSnapshotAt: request.evaluationNotBefore,
      outcomeCorrections: 'new_revision_not_a_replacement_for_the_first_evaluation', overflow: 'fail_without_truncation',
      discoveryCompleteness: 'unknown', scheduling: 'manual_no_background_automation' },
    assumptions: ['ACTUAL_LINEUPS_RECONSTRUCTED', 'CURRENT_VERIFIED_IDENTITIES', 'EVENT_TIME_OUTCOME_AVAILABILITY_ASSUMED',
      'PATCH_FEATURES_NOT_USED', 'REMOTE_SERIES_COMPLETENESS_UNKNOWN', 'LOCAL_PREREGISTRATION_NOT_EXTERNAL_TIMESTAMP_ATTESTATION'],
    syntheticOnly: prior.syntheticOnly, trainingReady: false, deployable: false, teamAWinProbability: null };
  return { ...body, fingerprint: hash(body) };
}
