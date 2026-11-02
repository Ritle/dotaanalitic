import { createHash } from 'node:crypto';
import { ELO_POLICY, replayElo, type EloMap } from '@dota/analytics';
import { ResearchEloBodySchema, ResearchEloExportSchema, ResearchEvidenceExclusionsSchema, type ResearchEloBody, type ResearchEloMap } from '@dota/contracts';
import { canonicalContextJson } from './temporal.js';
import { resolveIdentity } from './identity.js';
import { assessProviderSeriesAliases } from './dataset-splits.js';

export const RESEARCH_ELO_POLICY = 'isolated-elo-research-v1';
const hash = (value: unknown) => createHash('sha256').update(canonicalContextJson(value)).digest('hex');
const us = (time: string) => BigInt(Date.parse(time)) * 1000n;
const compareId = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const slots = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132];

export function freezeResearchElo(input: unknown) {
  const body = ResearchEloBodySchema.parse(input);
  body.candidates.sort((a, b) => compareId(a.startedAtUs, b.startedAtUs) || compareId(a.matchId, b.matchId));
  body.aliases.sort((a, b) => a.seriesId.localeCompare(b.seriesId));
  body.identities.sort((a, b) => a.observationId.localeCompare(b.observationId));
  body.code.sort((a, b) => a.path.localeCompare(b.path));
  for (const row of body.candidates) {
    row.players.sort((a, b) => a.playerSlot - b.playerSlot);
    row.receiptPlayers.sort((a, b) => a.playerSlot - b.playerSlot);
    row.facts.sort((a, b) => compareId(a.id, b.id));
  }
  return { ...body, fingerprint: hash(body) };
}

function mapReasons(m: ResearchEloMap, body: ResearchEloBody) {
  const reasons: string[] = [], snapshot = us(body.request.snapshotAt), start = BigInt(m.startedAtUs);
  if (m.isPro !== true) reasons.push('PRO_STATUS_UNVERIFIED');
  if (m.ingestState === 'conflict') reasons.push('MAP_CONFLICT');
  if (m.endedAtUs === null || BigInt(m.endedAtUs) <= start || BigInt(m.endedAtUs) > snapshot) reasons.push('MAP_NOT_COMPLETED');
  if (BigInt(m.syncedAtUs) > snapshot) reasons.push('CANONICAL_STATE_AFTER_SNAPSHOT');
  const o = m.outcome;
  if (o.status !== 'verified') reasons.push(...o.reasons.map(reason => `OUTCOME_${reason}`));
  else if (o.matchId !== m.matchId || o.teamAWon !== m.radiantWin || o.teamAId !== m.radiantTeamId ||
    o.teamBId !== m.direTeamId || o.teamAId === o.teamBId || o.seriesId !== m.seriesId || o.dataRevision !== m.dataRevision ||
    us(o.startedAt) !== start || m.endedAtUs === null || us(o.completedAt) !== BigInt(m.endedAtUs) ||
    o.labelVerifiedAt !== body.request.snapshotAt || o.sourceEvidence.receiptId !== o.outcomeReceiptId ||
    o.sourceEvidence.receiptFetchedAt > body.request.snapshotAt) reasons.push('OUTCOME_BINDING_INVALID');
  if (m.players.length !== 10 || m.players.some((p, i) => p.playerSlot !== slots[i]) ||
    m.players.some(p => p.sourceAccountId === null || BigInt(p.sourceAccountId) >= 4294967295n) ||
    new Set(m.players.map(p => p.sourceAccountId)).size !== 10) reasons.push('ACTUAL_ROSTER_INVALID');
  if (canonicalContextJson(m.players) !== canonicalContextJson(m.receiptPlayers)) reasons.push('ROSTER_RECEIPT_MISMATCH');
  if (!m.seriesSourceMatched) reasons.push('SERIES_SOURCE_UNVERIFIED');
  return reasons;
}

/** Aggregate offline diagnostics only. No per-map win probabilities escape this boundary. */
export function evaluateResearchElo(input: unknown) {
  return evaluate(input, []);
}

/** Additional source-evidence exclusions; never changes facts or the legacy Elo/temporal policy. */
export function evaluateResearchEloWithExclusions(input: unknown, exclusions: unknown) {
  const rows = ResearchEvidenceExclusionsSchema.parse(exclusions);
  if (new Set(rows.map(r => r.matchId)).size !== rows.length) throw Error('research_duplicate_exclusion');
  return evaluate(input, rows);
}

function evaluate(input: unknown, exclusions: { matchId: string; reasons: string[] }[]) {
  const parsed = ResearchEloExportSchema.parse(input), { fingerprint, ...body } = parsed;
  if (hash(body) !== fingerprint) throw new Error('research_export_fingerprint_mismatch');
  if (canonicalContextJson(body.policy) !== canonicalContextJson(ELO_POLICY)) throw new Error('research_elo_policy_mismatch');
  if (body.candidates.length > body.request.maxMaps || body.aliases.length > body.request.maxMaps) throw new Error('research_inventory_limit');
  if (new Set(body.candidates.map(m => m.matchId)).size !== body.candidates.length) throw new Error('research_duplicate_map');
  const extra = new Map(exclusions.map(r => [r.matchId, r.reasons]));
  if (exclusions.some(r => !body.candidates.some(m => m.matchId === r.matchId))) throw Error('research_unknown_exclusion');
  if (new Set(body.identities.map(m => m.observationId)).size !== body.identities.length) throw new Error('research_duplicate_identity_evidence');
  const aliases = assessProviderSeriesAliases(body.aliases), byAlias = new Map(aliases.map(a => [a.seriesId, a]));
  const from = us(body.request.fromAt), boundary = us(body.request.holdoutFromAt), to = us(body.request.toAt);
  const availableIdentities = body.identities.filter(row => row.fetchedAt <= body.request.snapshotAt);
  const rows = body.candidates.map(map => {
    const m = { ...map, players: [...map.players].sort((a, b) => a.playerSlot - b.playerSlot),
      receiptPlayers: [...map.receiptPlayers].sort((a, b) => a.playerSlot - b.playerSlot) };
    const reasons = [...mapReasons(m, body), ...(extra.get(m.matchId) ?? [])], start = BigInt(m.startedAtUs);
    if (start < from || start >= to) reasons.push('OUTSIDE_WINDOW');
    const alias = m.seriesId === null ? undefined : byAlias.get(m.seriesId), key = alias?.providerSeriesKey ?? null;
    if (key === null) reasons.push('SERIES_UNKNOWN');
    if (alias?.seriesConflict) reasons.push('SERIES_ORGANIZATION_CONFLICT');
    if (alias && !alias.seriesOrganizationsKnown) reasons.push('SERIES_ORGANIZATIONS_UNKNOWN');
    const ids = m.players.map(p => p.sourceAccountId !== null && BigInt(p.sourceAccountId) < 4294967295n ?
      resolveIdentity(availableIdentities, p.sourceAccountId, null).playerId : null);
    if (ids.length !== 10 || ids.some(id => id === null) || new Set(ids).size !== 10) reasons.push('CURRENT_IDENTITIES_UNVERIFIED');
    return { map: m, key, reasons, playerIds: ids, split: start < boundary ? 'warmup' as const : 'holdout' as const };
  });
  const groups = new Map<string, typeof rows>();
  for (const row of rows) if (row.key !== null) { const group = groups.get(row.key) ?? []; group.push(row); groups.set(row.key, group); }
  const spans = [...groups].map(([key, members]) => {
    const starts = members.map(r => BigInt(r.map.startedAtUs));
    const ends = members.map(r => BigInt(r.map.endedAtUs ?? r.map.startedAtUs));
    return { key, members, start: starts.reduce((a, b) => a < b ? a : b), end: ends.reduce((a, b) => a > b ? a : b) };
  }).sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.key.localeCompare(b.key));
  for (const span of spans) {
    const groupReasons: string[] = [];
    if (span.members.some(row => row.reasons.includes('OUTSIDE_WINDOW'))) groupReasons.push('SERIES_OUTSIDE_WINDOW');
    if (span.start < boundary && span.end > boundary) groupReasons.push('SERIES_CROSSES_HOLDOUT');
    if (span.members.some(row => row.reasons.length > 0)) groupReasons.push('SERIES_HAS_INELIGIBLE_MEMBER');
    for (const row of span.members) row.reasons.push(...groupReasons);
  }
  for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length && spans[j]!.start < spans[i]!.end; j++) {
    for (const row of [...spans[i]!.members, ...spans[j]!.members]) row.reasons.push('SERIES_TIME_OVERLAP');
  }
  const assessments = rows.map(row => ({ matchId: row.map.matchId, seriesKey: row.key,
    split: row.reasons.length ? null : row.split, reasons: [...new Set(row.reasons)].sort() }));
  const eligible = rows.filter(row => row.reasons.length === 0);
  const maps: EloMap[] = eligible.map(row => ({ matchId: row.map.matchId, startedAtUs: row.map.startedAtUs,
    endedAtUs: row.map.endedAtUs!, availableAtUs: row.map.endedAtUs!, // Explicit research event clock, NOT source knownAt.
    radiantPlayerIds: row.playerIds.slice(0, 5) as string[], direPlayerIds: row.playerIds.slice(5) as string[], radiantWin: row.map.radiantWin! }));
  const replay = replayElo(maps, to.toString()), byId = new Map(eligible.map(row => [row.map.matchId, row]));
  let brier = 0, logLoss = 0, scoredMaps = 0, allUnseen = 0, withHistory = 0;
  const observations = replay.observations.map(observation => {
    const row = byId.get(observation.matchId)!;
    const features = { matchId: observation.matchId, startedAtUs: observation.startedAtUs,
      radiant: { playerIds: observation.radiant.playerIds, ratingBefore: observation.radiant.ratingBefore, priorPlayers: observation.radiant.priorPlayers },
      dire: { playerIds: observation.dire.playerIds, ratingBefore: observation.dire.ratingBefore, priorPlayers: observation.dire.priorPlayers } };
    const priorPlayers = features.radiant.priorPlayers + features.dire.priorPlayers;
    if (row.split === 'holdout') {
      const p = 1 / (1 + 10 ** ((features.dire.ratingBefore - features.radiant.ratingBefore) / ELO_POLICY.scale));
      const y = row.map.radiantWin ? 1 : 0;
      const clipped = Math.max(1e-15, Math.min(1 - 1e-15, p));
      brier += (p - y) ** 2; logLoss -= y * Math.log(clipped) + (1 - y) * Math.log(1 - clipped); scoredMaps++;
      if (priorPlayers === 10) allUnseen++; else withHistory++;
    }
    return { matchId: row.map.matchId, seriesKey: row.key, split: row.split, priorPlayers, featureFingerprint: hash(features) };
  });
  const warmupMaps = eligible.filter(r => r.split === 'warmup').length;
  const reason = !warmupMaps ? 'NO_WARMUP_MAPS' : !scoredMaps ? 'NO_HOLDOUT_MAPS' : null;
  const result = { schemaVersion: 1, format: 'research-elo-evaluation-v1', policyVersion: RESEARCH_ELO_POLICY,
    cohort: body.cohort, sourceFingerprint: fingerprint, request: body.request, eloPolicy: ELO_POLICY,
    status: reason === null ? 'research_complete' : 'unavailable', reason,
    summary: { candidateMaps: rows.length, eligibleMaps: eligible.length, excludedMaps: rows.length - eligible.length,
      warmupMaps, holdoutMaps: scoredMaps, scoredMaps: reason === null ? scoredMaps : 0,
      holdoutSeries: new Set(eligible.filter(r => r.split === 'holdout').map(r => r.key)).size,
      allTenPlayersUnseenHoldoutMaps: allUnseen, holdoutMapsWithPriorPlayerHistory: withHistory,
      replayUpdatesApplied: replay.observations.filter(r => r.updateApplied).length },
    metrics: reason === null ? { brier: brier / scoredMaps, logLoss: logLoss / scoredMaps,
      constantPriorBaseline: { brier: 0.25, logLoss: Math.log(2), n: scoredMaps } } : null,
    assessments, observations,
    assumptions: ['ACTUAL_LINEUPS_RECONSTRUCTED', 'CURRENT_VERIFIED_IDENTITIES', 'EVENT_TIME_OUTCOME_AVAILABILITY_ASSUMED',
      'PATCH_FEATURES_NOT_USED', 'PREQUENTIAL_HOLDOUT_UPDATES_AFTER_COMPLETION', 'REMOTE_SERIES_COMPLETENESS_UNKNOWN'],
    historicalAvailability: 'not_verified', prospectiveAccuracy: 'not_assessed', calibration: 'not_performed',
    syntheticOnly: body.syntheticOnly, trainingReady: false, deployable: false, teamAWinProbability: null };
  return { ...result, fingerprint: hash(result) };
}
