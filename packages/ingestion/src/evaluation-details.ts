import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EvaluationDetailEntrySchema, type EvaluationDetailEntry } from '@dota/contracts';
import { canonicalContextJson, verifyV1Data } from '@dota/db';
import { buildEvaluationDiscoveryLedger } from './evaluation-discovery.js';
import { type OpenDotaClient, OpenDotaError, type ProviderObservation } from './opendota/client.js';
import { MatchSourceSchema, HeroesSchema, LeaguesSchema } from './opendota/schemas.js';
import { classifyLeague, completedObservation, parseSource } from './quality.js';

type Ledger = ReturnType<typeof buildEvaluationDiscoveryLedger>;
const hash = (v: unknown) => createHash('sha256').update(canonicalContextJson(v)).digest('hex');
const idOrder = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const time = z.iso.datetime({ precision: 3 });
export function selectEvaluationDetailBatch(ledger: Ledger, batchIndexInput: unknown) {
  const batchIndex = z.number().int().min(0).max(99).parse(batchIndexInput);
  const selected = ledger.candidates.filter(c => c.possibleTarget || c.disposition === 'related_series_member').map(c => c.matchId).sort(idOrder);
  if (ledger.candidates.length > ledger.scope.maxMaps) throw Error('detail_inventory_limit');
  return { batchIndex, batchSize: 50, allRequiredIds: selected,
    selectedIds: selected.slice(batchIndex * 50, (batchIndex + 1) * 50),
    deferredIds: selected.filter((_, i) => i < batchIndex * 50 || i >= (batchIndex + 1) * 50) };
}

function decode<T>(entry: EvaluationDetailEntry | undefined, endpoint: string, schema: z.ZodType<T>): ProviderObservation<T> | null {
  if (!entry || entry.endpoint !== endpoint || entry.status !== 'captured') return null;
  const { observation } = entry;
  if (observation.source.endpoint !== endpoint || createHash('sha256').update(observation.rawBody).digest('hex') !== observation.source.payloadSha256) {
    throw Error('detail_source_binding_invalid');
  }
  return { ...observation, data: schema.parse(JSON.parse(observation.rawBody)) };
}

/** Fully replay captured source evidence before import. No canonical identity or model eligibility inferred here. */
export function validateEvaluationDetails(ledger: Ledger, entriesInput: unknown[], batchIndex: unknown, startedAt: string, completedAt: string) {
  time.parse(startedAt); time.parse(completedAt);
  if (startedAt > completedAt || startedAt < ledger.completedAt) throw Error('detail_capture_clock_invalid');
  const selection = selectEvaluationDetailBatch(ledger, batchIndex), entries = entriesInput.map(e => EvaluationDetailEntrySchema.parse(e));
  const endpoints = selection.selectedIds.length ? ['/heroes', '/leagues', ...selection.selectedIds.map(id => `/matches/${id}`)] : [];
  if (entries.length !== endpoints.length || entries.some((e, i) => e.endpoint !== endpoints[i] ||
    e.matchId !== (i < 2 ? null : selection.selectedIds[i - 2]) ||
    (e.status === 'captured' ? e.observation.source.fetchedAt : e.failedAt) < startedAt ||
    (e.status === 'captured' ? e.observation.source.fetchedAt : e.failedAt) > completedAt)) throw Error('detail_receipt_inventory_invalid');
  const heroes = decode(entries[0], '/heroes', HeroesSchema), leagues = decode(entries[1], '/leagues', LeaguesSchema);
  const matches = selection.selectedIds.map((matchId, i) => {
    const entry = entries[i + 2]!, observation = decode(entry, `/matches/${matchId}`, MatchSourceSchema);
    const reasons: string[] = [];
    if (!heroes || !leagues) reasons.push('REFERENCE_SOURCE_UNAVAILABLE');
    const candidate = ledger.candidates.find(c => c.matchId === matchId)!;
    if (!observation) return { matchId, observation: null, sourceEligible: false, reasons: [...reasons, 'DETAIL_FETCH_FAILED'] };
    const parsed = parseSource(observation, matchId), m = parsed.match;
    if (!m) reasons.push(...parsed.issues);
    else {
      if (!completedObservation(m, observation.source.fetchedAt) || typeof m.radiant_win !== 'boolean') reasons.push('COMPLETED_OUTCOME_REQUIRED');
      const found = leagues?.data.filter(l => l.leagueid === m.leagueid) ?? [];
      if (found.length !== 1 || classifyLeague(found[0]?.tier) !== true) reasons.push('PRO_STATUS_UNVERIFIED');
      const fields = ['start_time', 'leagueid', 'series_id', 'radiant_team_id', 'dire_team_id'] as const;
      if (candidate.observations.some(o => fields.some(f => o.metadata[f] !== null && o.metadata[f] !== m[f]))) reasons.push('DISCOVERY_DETAIL_CONFLICT');
      if (candidate.disposition === 'metadata_conflict') reasons.push('DISCOVERY_METADATA_CONFLICT');
      const slots = (m.players ?? []).map(p => p.player_slot).sort((a, b) => (a ?? -1) - (b ?? -1));
      if (canonicalContextJson(slots) !== canonicalContextJson([0, 1, 2, 3, 4, 128, 129, 130, 131, 132]) ||
        m.players?.some(p => p.account_id === null || p.account_id === undefined || BigInt(p.account_id) >= 4294967295n) ||
        new Set(m.players?.map(p => p.account_id)).size !== 10) reasons.push('ACTUAL_ACCOUNTS_INVALID');
    }
    if (observation.source.fetchedAt > ledger.scope.snapshotAt) reasons.push('SOURCE_AFTER_EVALUATION_SNAPSHOT');
    return { matchId, observation, sourceEligible: reasons.length === 0, reasons };
  });
  const body = { schemaVersion: 1, format: 'evaluation-details-assessment-v1', discoveryFingerprint: ledger.fingerprint,
    startedAt, completedAt, selection, assessments: matches.map(({ matchId, sourceEligible, reasons, observation }) =>
      ({ matchId, sourceEligible, reasons, payloadSha256: observation?.source.payloadSha256 ?? null })),
    deferredIds: selection.deferredIds, proEligibility: 'canonical_verification_required', metrics: null,
    trainingReady: false, deployable: false, teamAWinProbability: null };
  const report = { ...body, fingerprint: hash(body) };
  const provider: Pick<OpenDotaClient, 'getMatchSource' | 'getHeroes' | 'getLeagues'> = {
    async getMatchSource(id) { const match = matches.find(m => m.matchId === id && m.sourceEligible); if (!match?.observation) throw Error('detail_not_importable'); return match.observation; },
    async getHeroes() { if (!heroes) throw Error('detail_reference_unavailable'); return heroes; },
    async getLeagues() { if (!leagues) throw Error('detail_reference_unavailable'); return leagues; }
  };
  return { report, provider, matches };
}

export async function captureEvaluationDetails(ledger: Ledger, batchIndex: unknown,
  client: Pick<OpenDotaClient, 'getHeroes' | 'getLeagues' | 'getMatchSource'>,
  persist: (entry: EvaluationDetailEntry) => Promise<void>, now = () => new Date().toISOString()) {
  const selection = selectEvaluationDetailBatch(ledger, batchIndex), startedAt = now(), entries: EvaluationDetailEntry[] = [];
  const operations: { endpoint: string; matchId: string | null; run: () => Promise<ProviderObservation<unknown>> }[] = selection.selectedIds.length ? [
    { endpoint: '/heroes', matchId: null, run: () => client.getHeroes() },
    { endpoint: '/leagues', matchId: null, run: () => client.getLeagues() },
    ...selection.selectedIds.map(matchId => ({ endpoint: `/matches/${matchId}`, matchId, run: () => client.getMatchSource(matchId) }))
  ] : [];
  for (const op of operations) {
    let entry: EvaluationDetailEntry;
    try { const { source, rawBody } = await op.run(); entry = { status: 'captured', endpoint: op.endpoint, matchId: op.matchId, observation: { source, rawBody } }; }
    catch (e) { entry = { status: 'failed', endpoint: op.endpoint, matchId: op.matchId, failedAt: now(), code: e instanceof OpenDotaError ? e.code : 'detail_source_error' }; }
    await persist(entry); entries.push(entry);
  }
  const completedAt = now(), validated = validateEvaluationDetails(ledger, entries, batchIndex, startedAt, completedAt);
  return { entries, ...validated };
}

/** Current data-readiness diagnostics only. All discovered targets remain in coverage, including not-yet-imported maps. */
export function reconcileEvaluationCandidates(ledger: Ledger, developmentInput: unknown, detailsReport?: ReturnType<typeof validateEvaluationDetails>['report']) {
  const dataset = verifyV1Data(developmentInput);
  if (detailsReport && detailsReport.discoveryFingerprint !== ledger.fingerprint) throw Error('detail_reconciliation_scope_invalid');
  const sourceById = new Map(dataset.source.candidates.map(m => [m.matchId, m]));
  const assessmentById = new Map(dataset.report.assessments.map(a => [a.matchId, a]));
  const outsideTargetSeries = new Set(dataset.report.assessments.filter(a => {
    const map = sourceById.get(a.matchId)!;
    return a.seriesKey !== null && !ledger.scope.windows.some(w => BigInt(map.startedAtUs) >= BigInt(Date.parse(w.fromAt)) * 1000n &&
      BigInt(map.startedAtUs) < BigInt(Date.parse(w.until)) * 1000n);
  }).flatMap(a => a.seriesKey ?? []));
  const rows = ledger.candidates.filter(c => c.possibleTarget || c.disposition === 'related_series_member').map(c => {
    const map = sourceById.get(c.matchId), assessment = assessmentById.get(c.matchId), reasons: string[] = [];
    const detail = detailsReport?.assessments.find(a => a.matchId === c.matchId);
    if (!detail) reasons.push('DETAIL_NOT_CAPTURED_IN_THIS_BATCH'); else if (!detail.sourceEligible) reasons.push(...detail.reasons);
    if (!map || !assessment) reasons.push('CANONICAL_MAP_MISSING');
    else {
      reasons.push(...assessment.reasons);
      if (map.outcome.status !== 'verified') reasons.push('CANONICAL_OUTCOME_UNVERIFIED');
      else if (detail?.payloadSha256 !== map.outcome.sourceEvidence.payloadSha256) reasons.push('DETAIL_CANONICAL_RECEIPT_MISMATCH');
      if (c.metadata.start_time !== null && BigInt(map.startedAtUs) !== BigInt(c.metadata.start_time) * 1000000n) reasons.push('CANONICAL_START_MISMATCH');
      if (c.seriesKey !== null && assessment.seriesKey !== c.seriesKey) reasons.push('CANONICAL_SERIES_MISMATCH');
      if (assessment.seriesKey !== null && outsideTargetSeries.has(assessment.seriesKey)) reasons.push('CANONICAL_SERIES_OUTSIDE_TARGET_WINDOW');
      if (c.disposition === 'metadata_conflict' || c.disposition === 'scope_uncertain') reasons.push('DISCOVERY_SCOPE_UNRESOLVED');
    }
    return { matchId: c.matchId, possibleTarget: c.possibleTarget, seriesKey: c.seriesKey ?? assessment?.seriesKey ?? null, canonicalSeriesKey: assessment?.seriesKey ?? null,
      outcomeVerified: map?.outcome.status === 'verified', dataReady: reasons.length === 0, reasons: [...new Set(reasons)].sort() };
  });
  // Every observed sibling is checked, not just the locally imported subset.
  const groups = new Map<string, typeof rows>();
  for (const row of rows) for (const key of new Set([row.seriesKey, row.canonicalSeriesKey].filter((key): key is string => key !== null))) {
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  for (const group of groups.values()) if (group.some(r => !r.dataReady || !r.possibleTarget)) for (const row of group) {
    row.reasons = [...new Set([...row.reasons, 'DISCOVERED_SERIES_HAS_UNREADY_OR_OUTSIDE_MEMBER'])].sort(); row.dataReady = false;
  }
  const targets = rows.filter(r => r.possibleTarget), knownSeries = [...new Set(targets.flatMap(r => [r.seriesKey, r.canonicalSeriesKey].filter((key): key is string => key !== null)))];
  const ready = targets.filter(r => r.dataReady).length, readySeries = knownSeries.filter(key => groups.get(key)?.every(r => r.dataReady && r.possibleTarget)).length;
  const body = { schemaVersion: 1, format: 'evaluation-candidate-reconciliation-v1', discoveryFingerprint: ledger.fingerprint,
    datasetFingerprint: dataset.fingerprint, snapshotAt: dataset.source.request.snapshotAt, detailsFingerprint: detailsReport?.fingerprint ?? null,
    assessments: rows, coverage: { observedTargetMaps: targets.length, dataReadyMaps: ready, mapCoverage: targets.length ? ready / targets.length : null,
      observedKnownSeries: knownSeries.length, readyKnownSeries: readySeries, knownSeriesCoverage: knownSeries.length ? readySeries / knownSeries.length : null,
      targetMapsWithVerifiedOutcomes: targets.filter(r => r.outcomeVerified).length },
    remoteCompleteness: 'unknown', eligibility: 'current_data_diagnostics_not_e1_or_release_scoring', metrics: null,
    trainingReady: false, deployable: false, teamAWinProbability: null };
  return { ...body, fingerprint: hash(body) };
}
