import { createHash } from 'node:crypto';
import { V1ReleaseCaptureBodySchema, V1ReleaseCaptureSchema } from '@dota/contracts';
import { canonicalContextJson, prepareReleaseHistory, verifyV1ExecutableFreeze, type verifyV1ReleasePlan } from '@dota/db';
import { createV1FeatureBuilder, verifyV1Candidate, type createV1Candidate } from '@dota/prediction';
import { type buildEvaluationDiscoveryLedger } from './evaluation-discovery.js';
import { selectEvaluationDetailBatch, type validateEvaluationDetails } from './evaluation-details.js';
import { MatchSchema } from './opendota/schemas.js';
type Plan = ReturnType<typeof verifyV1ReleasePlan>;
type Candidate = ReturnType<typeof createV1Candidate>;
type Ledger = ReturnType<typeof buildEvaluationDiscoveryLedger>;
type Batch = ReturnType<typeof validateEvaluationDetails>;
const hash = (v: unknown) => createHash('sha256').update(canonicalContextJson(v)).digest('hex');
const us = (s: string) => BigInt(Date.parse(s)) * 1000n;
const order = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
export function assertV1ReleaseCaptureTime(plan: Plan, now: string) {
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) throw Error('release_clock_invalid');
  if (now < plan.evaluateNotBefore) throw Error('release_capture_too_early');
}

/** Caller must fully replay raw discovery and detail files. This kernel never fetches, scores or activates. */
export function prepareV1ReleaseEvidence(plan: Plan, candidate: Candidate, inventoryInput: unknown, ledger: Ledger, batches: Batch[]) {
  verifyV1Candidate(candidate, candidate.registration);
  if (candidate.registration.planFingerprint !== plan.fingerprint || candidate.registration.qualityPolicySha256 !== hash(plan.qualityPolicy) ||
    candidate.registration.developmentFingerprint !== plan.developmentFingerprint || candidate.registration.testFromAt !== plan.testFromAt ||
    candidate.registration.evaluateNotBefore !== plan.evaluateNotBefore || candidate.registration.warmupFromAt !== plan.request.warmupFromAt ||
    candidate.registration.syntheticOnly !== plan.syntheticOnly) throw Error('release_candidate_binding');
  const prepared = prepareReleaseHistory(inventoryInput), { inventory } = prepared;
  const expectedWindow = { fromAt: plan.request.warmupFromAt, toAt: plan.request.snapshotAt,
    snapshotAt: plan.request.snapshotAt, maxMaps: plan.request.maxInventoryMaps };
  if (canonicalContextJson(inventory.source.request) !== canonicalContextJson(expectedWindow) ||
    inventory.source.syntheticOnly !== plan.syntheticOnly) throw Error('release_inventory_scope');
  const { fingerprint: ledgerFingerprint, ...ledgerBody } = ledger;
  if (hash(ledgerBody) !== ledgerFingerprint || ledger.scope.kind !== 'v1' || ledger.scope.planFingerprint !== plan.fingerprint ||
    ledger.scope.planSha256 !== candidate.registration.planSha256 || ledger.scope.snapshotAt !== plan.request.snapshotAt ||
    canonicalContextJson(ledger.scope.windows) !== canonicalContextJson(plan.request.events.map(e => ({ fromAt: e.fromAt, until: e.until, leagueId: e.leagueId }))))
    throw Error('release_discovery_scope');
  if (ledger.completedAt > plan.request.snapshotAt || ledger.candidates.length > plan.request.maxInventoryMaps) throw Error('release_evidence_horizon');
  const count = Math.ceil(selectEvaluationDetailBatch(ledger, 0).allRequiredIds.length / 50);
  const sorted = [...batches].sort((a, b) => a.report.selection.batchIndex - b.report.selection.batchIndex);
  if (sorted.length !== count || sorted.some((b, i) => b.report.discoveryFingerprint !== ledger.fingerprint ||
    canonicalContextJson(b.report.selection) !== canonicalContextJson(selectEvaluationDetailBatch(ledger, i)) ||
    canonicalContextJson(b.report.assessments.map(r => r.matchId)) !== canonicalContextJson(b.report.selection.selectedIds) ||
    canonicalContextJson(b.matches.map(r => r.matchId)) !== canonicalContextJson(b.report.selection.selectedIds))) throw Error('release_detail_batches');
  for (const b of sorted) {
    const { fingerprint, ...body } = b.report;
    if (hash(body) !== fingerprint || b.report.startedAt < ledger.completedAt || b.report.completedAt > plan.request.snapshotAt ||
      b.matches.some(m => { const a = b.report.assessments.find(r => r.matchId === m.matchId)!;
        return m.sourceEligible !== a.sourceEligible || canonicalContextJson(m.reasons) !== canonicalContextJson(a.reasons) ||
          (m.observation?.source.payloadSha256 ?? null) !== a.payloadSha256;
      })) throw Error('release_detail_binding');
  }
  const detailById = new Map(sorted.flatMap(b => b.matches).map(m => [m.matchId, m]));
  const canonical = new Map(inventory.source.candidates.map(m => [m.matchId, m]));
  if (plan.reviewedDevelopmentMaps.some(id => !canonical.has(id))) throw Error('release_reviewed_history_missing');
  const previouslyReviewed = new Set(plan.reviewedDevelopmentMaps);
  const metadata = new Map(inventory.metadata.map(m => [m.matchId, m]));
  const discovered = new Map(ledger.candidates.map(m => [m.matchId, m]));
  const assessed = new Map(prepared.assessments.map(m => [m.matchId, m]));
  const factsConflict = (map: typeof inventory.source.candidates[number]) => {
    const observation = detailById.get(map.matchId)?.observation;
    if (!observation) return false;
    const parsed = MatchSchema.safeParse(observation.data);
    if (!parsed.success) return true;
    const raw = parsed.data;
    const slots = (raw.players ?? []).map(p => ({ playerSlot: p.player_slot, sourceAccountId: p.account_id ?? null }))
      .sort((a, b) => (a.playerSlot ?? -1) - (b.playerSlot ?? -1));
    return raw.radiant_win !== map.radiantWin || typeof raw.start_time !== 'number' || typeof raw.duration !== 'number' ||
      BigInt(raw.start_time) * 1000000n !== BigInt(map.startedAtUs) || map.endedAtUs === null ||
      (BigInt(raw.start_time) + BigInt(raw.duration)) * 1000000n !== BigInt(map.endedAtUs) ||
      canonicalContextJson(slots) !== canonicalContextJson([...map.players].sort((a, b) => a.playerSlot - b.playerSlot));
  };
  const historyExclusions = inventory.source.candidates.flatMap(map => {
    const detail = detailById.get(map.matchId);
    // A failed HTTP attempt alone does not erase an independently verified historical receipt.
    // Conflicting captured facts exclude this map only, never its earlier/later siblings from history.
    return detail?.observation && (!detail.sourceEligible || factsConflict(map) || map.outcome.status === 'verified' &&
      detail.observation.source.payloadSha256 !== map.outcome.sourceEvidence.payloadSha256)
      ? [{ matchId: map.matchId, reason: 'CAPTURED_DETAIL_CONFLICTS_WITH_HISTORY' }] : [];
  }).sort((a, b) => order(a.matchId, b.matchId));
  const excludedHistory = new Set(historyExclusions.map(m => m.matchId));
  const history = { ...prepared.history, sourceFingerprint: hash({ perMapHistory: prepared.history.sourceFingerprint, historyExclusions }),
    maps: prepared.history.maps.filter(m => !excludedHistory.has(m.matchId)) };
  const features = createV1FeatureBuilder(history), historyById = new Map(history.maps.map(m => [m.matchId, m]));
  const inWindow = (start: bigint, league: string | null, allowUnknown: boolean) => plan.request.events.filter(e =>
    start >= us(e.fromAt) && start < us(e.until) && (league === e.leagueId || league === null && allowUnknown));
  const ids = [...new Set([...canonical.keys(), ...discovered.keys()])].sort(order);
  const rows = ids.map(matchId => {
    const map = canonical.get(matchId), c = discovered.get(matchId), detail = detailById.get(matchId), meta = metadata.get(matchId);
    const own = assessed.get(matchId), actual = historyById.get(matchId);
    const localPossible = map ? inWindow(BigInt(map.startedAtUs), meta?.leagueId ?? null, true) : [];
    const exactEvents = map ? inWindow(BigInt(map.startedAtUs), meta?.leagueId ?? null, false) : [];
    const target = localPossible.length > 0 || c?.possibleTarget === true;
    const seriesKeys = [...new Set([own?.seriesKey ?? null, ...(c?.observations.map(o =>
      o.metadata.series_id === null ? null : `opendota:${o.metadata.series_id}`) ?? [])].filter((k): k is string => k !== null))].sort();
    const reasons: string[] = [];
    let teamASide: 'radiant' | 'dire' | null = null;
    let feature: ReturnType<typeof features> | null = null;
    if (target || c?.disposition === 'related_series_member') {
      if (target && previouslyReviewed.has(matchId)) reasons.push('PRIOR_EXPOSURE_TARGET');
      if (!target || exactEvents.length !== 1) reasons.push('OUTSIDE_OR_UNKNOWN_TARGET_SCOPE');
      if (!c) reasons.push('LOCAL_TARGET_UNDISCOVERED');
      if (!detail) reasons.push('DETAIL_MISSING'); else if (!detail.sourceEligible) reasons.push('DETAIL_INELIGIBLE');
      if (!map) reasons.push('CANONICAL_MAP_MISSING'); else reasons.push(...(own?.reasons ?? ['MAP_ASSESSMENT_MISSING']));
      if (c?.disposition === 'metadata_conflict' || c?.disposition === 'scope_uncertain') reasons.push('DISCOVERY_UNRESOLVED');
      if (!own?.seriesKey || seriesKeys.length !== 1) reasons.push('SERIES_UNKNOWN_OR_CONFLICTING');
      if (map && c?.metadata.start_time != null && BigInt(map.startedAtUs) !== BigInt(c.metadata.start_time) * 1000000n) reasons.push('START_MISMATCH');
      if (map && c?.seriesKey && c.seriesKey !== own?.seriesKey) reasons.push('SERIES_MISMATCH');
      if (map?.outcome.status === 'verified' && detail?.observation?.source.payloadSha256 !== map.outcome.sourceEvidence.payloadSha256)
        reasons.push('CANONICAL_RECEIPT_MISMATCH');
      if (map && factsConflict(map)) reasons.push('CANONICAL_FACTS_MISMATCH');
      const raw = detail?.observation ? MatchSchema.safeParse(detail.observation.data).data : undefined;
      if (raw && meta && (raw.leagueid !== meta.leagueId || raw.radiant_team_id !== meta.radiantProviderTeamId ||
        raw.dire_team_id !== meta.direProviderTeamId)) reasons.push('CANONICAL_EVENT_OR_TEAMS_MISMATCH');
      if (target && actual && map?.radiantTeamId && map.direTeamId && map.radiantTeamId !== map.direTeamId) {
        teamASide = BigInt(map.radiantTeamId) < BigInt(map.direTeamId) ? 'radiant' : 'dire';
        feature = features({ schemaVersion: 1, targetMatchId: matchId, cutoffAtUs: map.startedAtUs,
          teamA: teamASide === 'radiant' ? actual.teamA : actual.teamB, teamB: teamASide === 'radiant' ? actual.teamB : actual.teamA,
          lineup: { basis: 'actual_lineup_reconstructed', source: 'verified-receipt:' + actual.outcomeReceiptId,
            selectedAtUs: actual.fetchedAtUs, revision: inventory.fingerprint } });
        reasons.push(...feature.reasons);
      } else if (target) reasons.push('TARGET_FEATURE_INPUT_UNAVAILABLE');
    }
    return { matchId, target, local: !!map, eventKey: exactEvents[0]?.eventKey ?? null,
      seriesKeys, canonicalSeriesKey: own?.seriesKey ?? null, teamASide,
      reasons: [...new Set(reasons)].sort(), featureFingerprint: feature?.fingerprint ?? null,
      historyCoverage: feature?.coverage ?? null, sourceReasons: detail?.reasons ?? [], discoveryReasons: c?.reasons ?? [] };
  });
  // Components connect all observed and canonical aliases; crossing an event/test boundary vetoes test rows only.
  const targetKeys = new Set(rows.filter(r => r.target).flatMap(r => r.seriesKeys));
  let changed = true;
  while (changed) { changed = false;
    for (const row of rows) if (row.seriesKeys.some(k => targetKeys.has(k))) for (const key of row.seriesKeys)
      if (!targetKeys.has(key)) { targetKeys.add(key); changed = true; }
  }
  for (const row of rows) if (!row.target && row.seriesKeys.some(k => targetKeys.has(k))) row.reasons.push('SERIES_MEMBER_OUTSIDE_TARGET');
  for (const key of targetKeys) {
    const events = new Set(rows.filter(r => r.seriesKeys.includes(key) && r.eventKey !== null).map(r => r.eventKey));
    if (events.size > 1) for (const row of rows.filter(r => r.seriesKeys.includes(key))) row.reasons.push('SERIES_CROSSES_EVENTS');
  }
  const blocked = new Set(rows.filter(r => r.reasons.length).flatMap(r => r.seriesKeys));
  changed = true;
  while (changed) { changed = false;
    for (const row of rows) if (row.seriesKeys.some(k => blocked.has(k))) {
      for (const key of row.seriesKeys) if (!blocked.has(key)) { blocked.add(key); changed = true; }
      if (!row.reasons.includes('SERIES_MEMBER_EXCLUDED')) row.reasons.push('SERIES_MEMBER_EXCLUDED');
    }
  }
  for (const row of rows) row.reasons = [...new Set(row.reasons)].sort();
  const targets = rows.filter(r => r.target), keys = [...new Set(targets.flatMap(r => r.seriesKeys))];
  const eligible = targets.filter(r => r.reasons.length === 0).length;
  const readySeries = keys.filter(k => rows.filter(r => r.seriesKeys.includes(k)).every(r => r.target && r.reasons.length === 0)).length;
  const body = { schemaVersion: 1, format: 'v1-release-source-binding-v1', planFingerprint: plan.fingerprint,
    candidateFingerprint: candidate.fingerprint, inventoryFingerprint: inventory.fingerprint, discoveryFingerprint: ledger.fingerprint,
    batchFingerprints: sorted.map(b => b.report.fingerprint), historyFingerprint: history.sourceFingerprint, historyExclusions,
    rows, coverage: { observedTargetMaps: targets.length, dataReadyMaps: eligible, mapCoverage: targets.length ? eligible / targets.length : null,
      observedKnownSeries: keys.length, dataReadySeries: readySeries, knownSeriesCoverage: keys.length ? readySeries / keys.length : null },
    discoveryStatus: ledger.status, stoppingReasons: ledger.stoppingReasons, remoteCompleteness: 'unknown',
    sourceHistoryCompleteness: 'only_explicitly_supplied_runs', metrics: null, releaseGatePassed: false, deployable: false, teamAWinProbability: null };
  return { ...body, fingerprint: hash(body) };
}

export function freezeV1ReleaseCapture(plan: Plan, candidate: Candidate, inventory: unknown, ledger: Ledger, batches: Batch[],
  capturedAt: string, files: unknown, filesSha256: string, executionCode: unknown, executableFreeze?: unknown) {
  assertV1ReleaseCaptureTime(plan, capturedAt);
  const binding = prepareV1ReleaseEvidence(plan, candidate, inventory, ledger, batches);
  const body = V1ReleaseCaptureBodySchema.parse({ schemaVersion: 1, format: 'v1-release-source-capture-v1', capturedAt,
    planFingerprint: plan.fingerprint, candidateFingerprint: candidate.fingerprint, files, filesSha256,
    inventory, bindingFingerprint: binding.fingerprint, executionCode, evaluation: 'not_performed',
    executableFreezeComplete: executableFreeze !== undefined, ...(executableFreeze === undefined ? {} : { executableFreeze }),
    releaseGatePassed: false, deployable: false, teamAWinProbability: null });
  if (!!body.files.freeze !== !!body.executableFreeze) throw Error('freeze_capture_binding');
  if (body.executableFreeze) verifyV1ExecutableFreeze(body.executableFreeze, plan, candidate, body.files.planSha256,
    body.files.candidateSha256, body.executionCode, body.executableFreeze.runtime);
  return { ...body, fingerprint: hash(body) };
}
export function verifyV1ReleaseCapture(plan: Plan, candidate: Candidate, input: unknown, ledger: Ledger, batches: Batch[], now: string) {
  assertV1ReleaseCaptureTime(plan, now);
  const parsed = V1ReleaseCaptureSchema.parse(input);
  if (parsed.executableFreezeComplete !== !!parsed.executableFreeze) throw Error('freeze_capture_binding');
  if (parsed.capturedAt > now) throw Error('release_capture_in_future');
  const rebuilt = freezeV1ReleaseCapture(plan, candidate, parsed.inventory, ledger, batches, parsed.capturedAt,
    parsed.files, parsed.filesSha256, parsed.executionCode, parsed.executableFreeze);
  if (canonicalContextJson(rebuilt) !== canonicalContextJson(parsed)) throw Error('release_capture_replay_mismatch');
  return { capture: rebuilt, binding: prepareV1ReleaseEvidence(plan, candidate, rebuilt.inventory, ledger, batches) };
}
