import { createHash } from 'node:crypto';
import { V1DataSourceSchema, V1DataEnvelopeSchema } from '@dota/contracts';
import { canonicalContextJson } from './temporal.js';
import { resolveIdentity } from './identity.js';
import { assessProviderSeriesAliases } from './dataset-splits.js';

export const V1_DATA_POLICY = 'conditional-player-history-preparation-v1';
const hash = (value: unknown) => createHash('sha256').update(canonicalContextJson(value)).digest('hex');
const us = (time: string) => BigInt(Date.parse(time)) * 1000n;
const cmp = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const textCompare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const nativeSlots = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132];
const distinct = (values: readonly string[], reason: string) => {
  if (new Set(values).size !== values.length) throw new Error(reason);
};

/** Dataset preparation only: no rating, fitting, split selection or probabilities. */
export function prepareV1Data(input: unknown) {
  return prepareV1DataInternal(input, false);
}

/** Per-map history, independent of target-series evaluation exclusions. Original development profile unchanged. */
export function prepareV1MapHistory(input: unknown) {
  const prepared = prepareV1DataInternal(input, true);
  const body = { schemaVersion: 1, format: 'v1-per-map-history-v1', source: prepared.source,
    report: { ...prepared.report, policyVersion: 'conditional-per-map-history-v1',
      assumptions: [...prepared.report.assumptions, 'TARGET_SERIES_EXCLUSIONS_DO_NOT_REMOVE_HISTORY'] } };
  return { ...body, fingerprint: hash(body) };
}

function prepareV1DataInternal(input: unknown, perMapHistory: boolean) {
  const source = V1DataSourceSchema.parse(input), request = source.request;
  if (source.candidates.length > request.maxMaps || source.aliases.length > request.maxMaps) throw new Error('v1_inventory_limit');
  distinct(source.candidates.map(m => m.matchId), 'v1_duplicate_map');
  distinct(source.identities.map(i => i.observationId), 'v1_duplicate_identity_evidence');
  distinct(source.code.map(c => c.path), 'v1_duplicate_code_path');
  source.candidates.sort((a, b) => cmp(a.startedAtUs, b.startedAtUs) || cmp(a.matchId, b.matchId));
  source.aliases.sort((a, b) => textCompare(a.seriesId, b.seriesId));
  source.identities.sort((a, b) => textCompare(a.observationId, b.observationId));
  source.code.sort((a, b) => textCompare(a.path, b.path));
  for (const m of source.candidates) {
    m.players.sort((a, b) => a.playerSlot - b.playerSlot);
    m.receiptPlayers.sort((a, b) => a.playerSlot - b.playerSlot);
    m.facts.sort((a, b) => cmp(a.id, b.id));
  }
  if (!source.syntheticOnly && /synthetic|fixture|demo/i.test(canonicalContextJson([
    source.candidates, source.identities, source.aliases, source.code
  ]))) throw new Error('v1_synthetic_evidence_forbidden');
  const aliases = assessProviderSeriesAliases(source.aliases), byAlias = new Map(aliases.map(a => [a.seriesId, a]));
  const snapshot = us(request.snapshotAt), from = us(request.fromAt), to = us(request.toAt);
  const identities = source.identities.filter(i => i.fetchedAt <= request.snapshotAt &&
    (i.knownAt === null || i.knownAt <= request.snapshotAt) && (i.eventAt === null || i.eventAt <= request.snapshotAt));
  const accounts = [...new Set(source.candidates.flatMap(m => m.players.flatMap(p => p.sourceAccountId ?? [])))];
  const resolutions = new Map(accounts.filter(id => BigInt(id) < 4294967295n)
    .map(id => [id, resolveIdentity(identities.filter(i => i.externalAccountId === id), id, null)]));
  const rows = source.candidates.map(m => {
    const reasons: string[] = [], start = BigInt(m.startedAtUs), o = m.outcome;
    const selected = start >= from && start < to;
    if (!selected) reasons.push('OUTSIDE_WINDOW');
    if (m.isPro !== true) reasons.push('PRO_STATUS_UNVERIFIED');
    if (m.ingestState === 'conflict') reasons.push('MAP_CONFLICT');
    if (m.endedAtUs === null || BigInt(m.endedAtUs) <= start || BigInt(m.endedAtUs) > snapshot) reasons.push('MAP_NOT_COMPLETED_AT_SNAPSHOT');
    if (BigInt(m.syncedAtUs) > snapshot) reasons.push('CANONICAL_STATE_AFTER_SNAPSHOT');
    if (o.status !== 'verified') reasons.push(...o.reasons.map(r => 'OUTCOME_' + r));
    else if (o.matchId !== m.matchId || o.teamAWon !== m.radiantWin || o.teamAId !== m.radiantTeamId ||
      o.teamBId !== m.direTeamId || o.teamAId === o.teamBId || o.seriesId !== m.seriesId || o.dataRevision !== m.dataRevision ||
      us(o.startedAt) !== start || m.endedAtUs === null || us(o.completedAt) !== BigInt(m.endedAtUs) ||
      o.labelVerifiedAt !== request.snapshotAt || o.sourceEvidence.receiptId !== o.outcomeReceiptId ||
      o.sourceEvidence.receiptFetchedAt > request.snapshotAt) reasons.push('OUTCOME_BINDING_INVALID');
    if (m.players.length !== 10 || m.players.some((p, i) => p.playerSlot !== nativeSlots[i] || p.sourceAccountId === null ||
      BigInt(p.sourceAccountId) >= 4294967295n) || new Set(m.players.map(p => p.sourceAccountId)).size !== 10) reasons.push('ACTUAL_ROSTER_INVALID');
    if (canonicalContextJson(m.players) !== canonicalContextJson(m.receiptPlayers)) reasons.push('ROSTER_RECEIPT_MISMATCH');
    const resolved = m.players.map(p => p.sourceAccountId === null ? undefined : resolutions.get(p.sourceAccountId));
    const playerIds = resolved.map(r => r?.playerId ?? null);
    if (playerIds.length !== 10 || playerIds.some(id => id === null) || new Set(playerIds).size !== 10) reasons.push('CURRENT_IDENTITIES_UNVERIFIED');
    if (resolved.some(r => r?.status === 'conflict')) reasons.push('IDENTITY_CONFLICT');
    const alias = m.seriesId === null ? undefined : byAlias.get(m.seriesId), seriesKey = alias?.providerSeriesKey ?? null;
    if (seriesKey === null) reasons.push('SERIES_UNKNOWN');
    if (!m.seriesSourceMatched) reasons.push('SERIES_SOURCE_UNVERIFIED');
    if (alias?.seriesConflict) reasons.push('SERIES_ORGANIZATION_CONFLICT');
    if (alias && !alias.seriesOrganizationsKnown) reasons.push('SERIES_ORGANIZATIONS_UNKNOWN');
    if (alias && [alias.teamAId, alias.teamBId].sort().join(':') !== [m.radiantTeamId, m.direTeamId].sort().join(':')) reasons.push('SERIES_TEAM_BINDING_INVALID');
    return { map: m, selected, seriesKey, reasons, playerIds,
      identityProofIds: [...new Set(resolved.flatMap(r => r?.observationIds ?? []))].sort(textCompare) };
  });
  const groups = new Map<string, typeof rows>();
  for (const row of rows) if (row.seriesKey !== null) {
    const group = groups.get(row.seriesKey) ?? []; group.push(row); groups.set(row.seriesKey, group);
  }
  // Keep whole locally known series, including siblings outside the requested interval.
  // Concurrent unrelated series are allowed; timestamps, not serial import order, bound history.
  for (const members of perMapHistory ? [] : groups.values()) {
    const reasons: string[] = [];
    if (members.some(r => !r.selected)) reasons.push('SERIES_OUTSIDE_WINDOW');
    if (members.some(r => r.reasons.length > 0)) reasons.push('SERIES_HAS_INELIGIBLE_MEMBER');
    for (const row of members) row.reasons.push(...reasons);
  }
  const eligible = rows.filter(r => r.reasons.length === 0);
  const completed = [...eligible].sort((a, b) => cmp(a.map.endedAtUs!, b.map.endedAtUs!) || cmp(a.map.matchId, b.map.matchId));
  const counts = new Map<string, number>(); let cursor = 0;
  const examples = eligible.map(row => {
    while (cursor < completed.length && BigInt(completed[cursor]!.map.endedAtUs!) < BigInt(row.map.startedAtUs)) {
      for (const id of completed[cursor]!.playerIds as string[]) counts.set(id, (counts.get(id) ?? 0) + 1);
      cursor++;
    }
    const playerIds = row.playerIds as string[], priorMapsPerPlayer = playerIds.map(id => counts.get(id) ?? 0);
    const inputs = { cutoffAtUs: row.map.startedAtUs, teamAPlayerIds: playerIds.slice(0, 5), teamBPlayerIds: playerIds.slice(5),
      lineage: 'actual_lineup_reconstructed' as const, identityBasis: 'current_same_account_verified' as const };
    return { matchId: row.map.matchId, seriesKey: row.seriesKey!, inputs, inputFingerprint: hash(inputs),
      // Outcome and completion clock are never input features.
      label: { teamASide: 'radiant' as const, teamAWon: row.map.radiantWin!, completedAtUs: row.map.endedAtUs!,
        availabilityBasis: 'event_time_assumed' as const, outcome: row.map.outcome },
      identityProofIds: row.identityProofIds, historyCoverage: { priorMapsPerPlayer,
        playersWithHistory: priorMapsPerPlayer.filter(n => n > 0).length, priorEligibleMaps: cursor } };
  });
  const assessments = rows.map(r => ({ matchId: r.map.matchId, selected: r.selected, seriesKey: r.seriesKey,
    dataEligible: r.reasons.length === 0, reasons: [...new Set(r.reasons)].sort() }));
  const selected = rows.filter(r => r.selected), byReason: Record<string, number> = {};
  for (const row of assessments.filter(r => r.selected)) for (const reason of row.reasons) byReason[reason] = (byReason[reason] ?? 0) + 1;
  const report = { policyVersion: V1_DATA_POLICY, profile: request.profile, stage: 'pre_match', purpose: request.purpose,
    status: examples.length ? 'prepared' : 'unavailable', reason: examples.length ? null : 'NO_ELIGIBLE_MAPS',
    summary: { inventoryMaps: rows.length, selectedMaps: selected.length, eligibleMaps: examples.length,
      excludedMaps: selected.length - examples.length, outsideWindowMaps: rows.length - selected.length,
      eligibleSeries: new Set(examples.map(e => e.seriesKey)).size,
      mapsWithAllPlayersHistory: examples.filter(e => e.historyCoverage.playersWithHistory === 10).length,
      mapsWithNoPlayerHistory: examples.filter(e => e.historyCoverage.playersWithHistory === 0).length, byReason },
    examples, assessments,
    assumptions: ['ACTUAL_LINEUPS_RECONSTRUCTED', 'CURRENT_SAME_ACCOUNT_IDENTITIES', 'EVENT_TIME_OUTCOME_AVAILABILITY_ASSUMED',
      'ONLY_SELECTED_ELIGIBLE_HISTORY', 'REMOTE_SERIES_COMPLETENESS_UNKNOWN'],
    unusedInputs: ['patch', 'roles', 'heroes', 'draft_order', 'first_pick', 'side_advantage', 'cohesion'],
    historicalAvailability: 'not_verified', evaluation: 'not_performed', split: 'unassigned_development',
    featureState: 'not_built', coverageGate: 'not_registered', trainingReady: false, deployable: false,
    syntheticOnly: source.syntheticOnly, teamAWinProbability: null };
  const body = { schemaVersion: 1 as const, format: 'v1-development-dataset-v1' as const, source, report };
  return { ...body, fingerprint: hash(body) };
}

/** External file SHA is checked by CLI before this deterministic internal replay. */
export function verifyV1Data(input: unknown) {
  const parsed = V1DataEnvelopeSchema.parse(input), { fingerprint, ...body } = parsed;
  if (hash(body) !== fingerprint) throw new Error('v1_dataset_fingerprint_mismatch');
  const rebuilt = prepareV1Data(parsed.source);
  if (rebuilt.fingerprint !== fingerprint) throw new Error('v1_dataset_replay_mismatch');
  return rebuilt;
}
