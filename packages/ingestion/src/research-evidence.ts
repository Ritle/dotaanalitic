import { createHash } from 'node:crypto';
import { ResearchEvidenceExecutionBodySchema, ResearchEvidenceExecutionSchema } from '@dota/contracts';
import { canonicalContextJson, freezeResearchExecution, assertResearchExecutionTime, evaluateResearchEloWithExclusions } from '@dota/db';
import { type buildEvaluationDiscoveryLedger } from './evaluation-discovery.js';
import { selectEvaluationDetailBatch, type validateEvaluationDetails } from './evaluation-details.js';
type Plan = Parameters<typeof freezeResearchExecution>[0];
type Ledger = ReturnType<typeof buildEvaluationDiscoveryLedger>;
type Details = ReturnType<typeof validateEvaluationDetails>['report'];
type Snapshot = ReturnType<typeof freezeResearchExecution>['snapshot'];
const hash = (v: unknown) => createHash('sha256').update(canonicalContextJson(v)).digest('hex');
const us = (s: string) => BigInt(Date.parse(s)) * 1000n;

/** Only consumes fully replayed source ledgers/batches. No source facts or outcome labels are rewritten. */
export function prepareResearchEvidence(plan: Plan, snapshot: Snapshot, ledger: Ledger, batches: Details[]) {
  if (ledger.scope.kind !== 'e1' || ledger.scope.planFingerprint !== plan.fingerprint ||
    ledger.scope.snapshotAt !== plan.request.evaluationNotBefore || canonicalContextJson(ledger.scope.windows) !==
    canonicalContextJson([{ fromAt: plan.request.holdoutFromAt, until: plan.request.holdoutUntil, leagueId: null }])) throw Error('execution_evidence_scope');
  if (ledger.completedAt > ledger.scope.snapshotAt || ledger.candidates.length > ledger.scope.maxMaps) throw Error('execution_evidence_horizon');
  const required = selectEvaluationDetailBatch(ledger, 0).allRequiredIds;
  const count = Math.ceil(required.length / 50), sorted = [...batches].sort((a, b) => a.selection.batchIndex - b.selection.batchIndex);
  if (sorted.length !== count || sorted.some((b, i) => b.discoveryFingerprint !== ledger.fingerprint || b.selection.batchIndex !== i ||
    canonicalContextJson(b.selection) !== canonicalContextJson(selectEvaluationDetailBatch(ledger, i)) ||
    canonicalContextJson(b.assessments.map(a => a.matchId)) !== canonicalContextJson(b.selection.selectedIds))) throw Error('execution_evidence_batches');
  for (const batch of sorted) {
    const { fingerprint, ...body } = batch;
    if (hash(body) !== fingerprint || batch.startedAt < ledger.completedAt || batch.completedAt > ledger.scope.snapshotAt) throw Error('execution_evidence_batch_binding');
  }
  const details = new Map(sorted.flatMap(b => b.assessments).map(d => [d.matchId, d]));
  const local = new Map(snapshot.candidates.map(m => [m.matchId, m])), discovered = new Map(ledger.candidates.map(c => [c.matchId, c]));
  const aliases = new Map(snapshot.aliases.map(a => [a.seriesId, a.provider && a.providerSeriesId ? `${a.provider}:${a.providerSeriesId}` : null]));
  const rows = [...new Set([...local.keys(), ...discovered.keys()])].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1).map(matchId => {
    const map = local.get(matchId), candidate = discovered.get(matchId), detail = details.get(matchId);
    const localTarget = map !== undefined && BigInt(map.startedAtUs) >= us(plan.request.holdoutFromAt) && BigInt(map.startedAtUs) < us(plan.request.holdoutUntil);
    const target = localTarget || candidate?.possibleTarget === true;
    const needsEvidence = target || candidate?.disposition === 'related_series_member';
    const canonicalKey = map?.seriesId ? aliases.get(map.seriesId) ?? null : null;
    const keys = [...new Set([canonicalKey, ...(candidate?.observations.map(o => o.metadata.series_id === null ? null : `opendota:${o.metadata.series_id}`) ?? [])]
      .filter((v): v is string => v !== null))].sort();
    const reasons: string[] = [];
    if (needsEvidence) {
      if (!candidate) reasons.push('EVIDENCE_LOCAL_TARGET_UNDISCOVERED');
      if (!detail) reasons.push('EVIDENCE_DETAIL_MISSING');
      else if (!detail.sourceEligible) reasons.push('EVIDENCE_DETAIL_INELIGIBLE');
      if (!map) reasons.push('EVIDENCE_CANONICAL_MAP_MISSING');
      if (candidate?.disposition === 'metadata_conflict' || candidate?.disposition === 'scope_uncertain') reasons.push('EVIDENCE_DISCOVERY_UNRESOLVED');
      if (map && candidate?.metadata.start_time !== null && candidate?.metadata.start_time !== undefined &&
        BigInt(map.startedAtUs) !== BigInt(candidate.metadata.start_time) * 1000000n) reasons.push('EVIDENCE_START_MISMATCH');
      if (map && candidate?.seriesKey && candidate.seriesKey !== canonicalKey) reasons.push('EVIDENCE_SERIES_MISMATCH');
      if (map?.outcome.status === 'verified' && detail?.payloadSha256 !== map.outcome.sourceEvidence.payloadSha256) reasons.push('EVIDENCE_RECEIPT_MISMATCH');
    }
    // Remote outside siblings must not disappear just because they were never imported.
    if (!map && !target && keys.length) reasons.push('EVIDENCE_REMOTE_OUTSIDE_MEMBER');
    return { matchId, target, local: map !== undefined, seriesKeys: keys, reasons,
      sourceReasons: detail?.reasons ?? [], discoveryReasons: candidate?.reasons ?? [] };
  });
  // Connected components across every conflicting source/canonical series key, independent of input order.
  const blockedKeys = new Set(rows.filter(r => r.reasons.length).flatMap(r => r.seriesKeys));
  let changed = true;
  while (changed) { changed = false;
    for (const row of rows) if (row.seriesKeys.some(k => blockedKeys.has(k))) {
      for (const key of row.seriesKeys) if (!blockedKeys.has(key)) { blockedKeys.add(key); changed = true; }
      if (!row.reasons.includes('EVIDENCE_SERIES_MEMBER_EXCLUDED')) row.reasons.push('EVIDENCE_SERIES_MEMBER_EXCLUDED');
    }
  }
  for (const row of rows) row.reasons.sort();
  const body = { schemaVersion: 1, format: 'research-source-evidence-binding-v1', planFingerprint: plan.fingerprint,
    discoveryFingerprint: ledger.fingerprint, batchFingerprints: sorted.map(b => b.fingerprint), snapshotFingerprint: snapshot.fingerprint,
    discoveryStatus: ledger.status, stoppingReasons: ledger.stoppingReasons, sourceHistoryCompleteness: 'only_explicitly_supplied_runs',
    remoteCompleteness: 'unknown', rows,
    exclusions: rows.filter(r => r.local && r.reasons.length).map(r => ({ matchId: r.matchId, reasons: r.reasons })),
    metrics: null, deployable: false };
  return { ...body, fingerprint: hash(body) };
}

export function freezeEvidenceResearchExecution(plan: Plan, snapshot: unknown, capturedAt: string, code: unknown,
  evidence: unknown, ledger: Ledger, batches: Details[]) {
  const execution = freezeResearchExecution(plan, snapshot, capturedAt, code);
  const binding = prepareResearchEvidence(plan, execution.snapshot, ledger, batches);
  const body = ResearchEvidenceExecutionBodySchema.parse({ schemaVersion: 1, format: 'research-evidence-execution-v1',
    execution, evidence, evidenceFingerprint: binding.fingerprint, trainingReady: false, deployable: false });
  return { ...body, fingerprint: hash(body) };
}

export function evaluateEvidenceResearchExecution(plan: Plan, input: unknown, ledger: Ledger, batches: Details[], now: string) {
  assertResearchExecutionTime(plan, now);
  const parsed = ResearchEvidenceExecutionSchema.parse(input), { fingerprint, ...body } = parsed;
  if (hash(body) !== fingerprint || parsed.execution.capturedAt > now) throw Error('execution_evidence_binding');
  const rebuilt = freezeEvidenceResearchExecution(plan, parsed.execution.snapshot, parsed.execution.capturedAt,
    parsed.execution.executionCode, parsed.evidence, ledger, batches);
  if (canonicalContextJson(rebuilt) !== canonicalContextJson(parsed)) throw Error('execution_evidence_replay');
  const binding = prepareResearchEvidence(plan, parsed.execution.snapshot, ledger, batches);
  const evaluation = evaluateResearchEloWithExclusions(parsed.execution.snapshot, binding.exclusions);
  const byId = new Map(evaluation.assessments.map(a => [a.matchId, a]));
  const targets = binding.rows.filter(r => r.target).map(r => ({ ...r, scored: evaluation.status === 'research_complete' && byId.get(r.matchId)?.split === 'holdout',
    reasons: [...new Set([...r.reasons, ...(byId.get(r.matchId)?.reasons ?? []),
      ...(evaluation.reason === null ? [] : [evaluation.reason])])].sort() }));
  const series = [...new Set(targets.flatMap(r => r.seriesKeys))];
  const scored = targets.filter(r => r.scored).length;
  const scoredSeries = series.filter(key => targets.filter(r => r.seriesKeys.includes(key)).every(r => r.scored)).length;
  const report = { schemaVersion: 1, format: 'research-evidence-report-v1', executionFingerprint: fingerprint,
    planFingerprint: plan.fingerprint, binding, targets,
    coverage: { observedTargetMaps: targets.length, scoredMaps: scored, mapCoverage: targets.length ? scored / targets.length : null,
      observedKnownSeries: series.length, scoredKnownSeries: scoredSeries, knownSeriesCoverage: series.length ? scoredSeries / series.length : null },
    evaluation, releaseGate: 'not_assessed', trainingReady: false, deployable: false, teamAWinProbability: null };
  return { ...report, fingerprint: hash(report) };
}
