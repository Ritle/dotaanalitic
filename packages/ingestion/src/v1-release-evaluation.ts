import { createHash } from 'node:crypto';
import { V1ReleaseReportSchema, V1FrozenReleaseReportSchema, type V1MetricInput } from '@dota/contracts';
import { canonicalContextJson, prepareReleaseHistory } from '@dota/db';
import { createV1CandidateDiagnosticScorer, evaluateV1MetricDiagnostic } from '@dota/prediction';
import { verifyV1ReleaseCapture } from './v1-release-evidence.js';
const hash = (v: unknown) => createHash('sha256').update(canonicalContextJson(v)).digest('hex');

/** Caller replays pinned raw source files; CLI publishes only after journal commit. No activation. */
export function evaluateV1ReleaseCapture(...args: Parameters<typeof verifyV1ReleaseCapture>) {
  const [plan, candidate] = args;
  const { capture, binding } = verifyV1ReleaseCapture(...args);
  const prepared = prepareReleaseHistory(capture.inventory);
  const excluded = new Set(binding.historyExclusions.map(m => m.matchId));
  const history = { ...prepared.history,
    sourceFingerprint: hash({ perMapHistory: prepared.history.sourceFingerprint, historyExclusions: binding.historyExclusions }),
    maps: prepared.history.maps.filter(m => !excluded.has(m.matchId)) };
  if (history.sourceFingerprint !== binding.historyFingerprint) throw Error('release_history_replay_mismatch');
  const score = createV1CandidateDiagnosticScorer(candidate, candidate.registration);
  const byId = new Map(history.maps.map(m => [m.matchId, m]));
  const targets = binding.rows.filter(r => r.target);
  const rows: V1MetricInput['rows'] = [];
  const featureFingerprints: { matchId: string; fingerprint: string }[] = [];
  for (const target of targets.filter(r => r.reasons.length === 0)) {
    const map = byId.get(target.matchId);
    if (!map || !target.teamASide || !target.canonicalSeriesKey) throw Error('release_scoring_input_missing');
    const radiantA = target.teamASide === 'radiant';
    const result = score(history, { schemaVersion: 1, targetMatchId: map.matchId, cutoffAtUs: map.startedAtUs,
      teamA: radiantA ? map.teamA : map.teamB, teamB: radiantA ? map.teamB : map.teamA,
      lineup: { basis: 'actual_lineup_reconstructed', source: 'verified-receipt:' + map.outcomeReceiptId,
        selectedAtUs: map.fetchedAtUs, revision: capture.inventory.fingerprint } });
    if (result.status !== 'ready' || result.evaluationProbability === null || result.featureFingerprint !== target.featureFingerprint)
      throw Error('release_feature_replay_mismatch');
    rows.push({ matchId: map.matchId, seriesKey: target.canonicalSeriesKey, startedAtUs: map.startedAtUs,
      probability: result.evaluationProbability, teamAWon: radiantA ? map.teamAWon : !map.teamAWon });
    featureFingerprints.push({ matchId: map.matchId, fingerprint: result.featureFingerprint });
  }
  const metricLedger = targets.map(r => ({ matchId: r.matchId, seriesKey: r.canonicalSeriesKey ?? r.seriesKeys[0] ?? null,
    disposition: r.reasons.length ? 'excluded' as const : 'scored' as const, reasons: r.reasons }));
  const diagnostic = evaluateV1MetricDiagnostic({ schemaVersion: 1, purpose: 'unbound_metric_diagnostic',
    syntheticOnly: plan.syntheticOnly, ledger: metricLedger, rows });
  if (diagnostic.metricGateDecision === 'unavailable') throw Error('release_metric_input_invalid');
  // The mathematical kernel accepts one key per map. Source coverage must also count conflicting aliases.
  const fullCoverage = binding.coverage;
  if (rows.length !== fullCoverage.dataReadyMaps || diagnostic.coverage?.scoredSeries !== fullCoverage.dataReadySeries)
    throw Error('release_coverage_replay_mismatch');
  const sourceReasons: string[] = [];
  if (fullCoverage.knownSeriesCoverage === null || fullCoverage.knownSeriesCoverage < plan.qualityPolicy.sample.minKnownSeriesCoverage)
    sourceReasons.push('SOURCE_SERIES_COVERAGE');
  if (binding.discoveryStatus !== 'discovered') sourceReasons.push('DISCOVERY_INCOMPLETE');
  const qualityDecision = sourceReasons.length ? 'insufficient_evidence' : diagnostic.metricGateDecision;
  const body = { schemaVersion: 1, format: 'v1-release-evaluation-v1', executionFingerprint: capture.fingerprint,
    planFingerprint: plan.fingerprint, candidateFingerprint: candidate.fingerprint, bindingFingerprint: binding.fingerprint,
    scorerCode: capture.executionCode, historyFingerprint: history.sourceFingerprint, featureFingerprints,
    evaluation: { status: rows.length ? 'evaluation_complete' : 'unavailable', qualityDecision,
      reasons: [...new Set([...diagnostic.reasons, ...sourceReasons])].sort(), syntheticOnly: plan.syntheticOnly,
      basis: 'conditional_actual_lineups_reconstructed', metrics: diagnostic.metrics,
      uncertainty: diagnostic.uncertainty, stability: diagnostic.stability },
    coverage: { ...fullCoverage, scoredMaps: rows.length, scoredSeries: diagnostic.coverage!.scoredSeries },
    ledger: targets, scoredRows: rows,
    metricKernelCoverage: diagnostic.coverage, remoteCompleteness: 'unknown',
    sourceHistoryCompleteness: 'only_explicitly_supplied_runs',
    publicationBlockers: ['EXECUTABLE_NOT_FROZEN', ...(plan.syntheticOnly ? ['SYNTHETIC_ONLY'] : [])],
    executableFreezeComplete: false, releaseGatePassed: false, deployable: false, teamAWinProbability: null };
  if (!capture.executableFreeze) return V1ReleaseReportSchema.parse({ ...body, fingerprint: hash(body) });
  const finalBody = { ...body, format: 'v1-release-evaluation-v2', executableFreezeComplete: true,
    freezeFingerprint: capture.executableFreeze.fingerprint, freezeSha256: capture.files.freeze!.sha256,
    releaseGatePassed: qualityDecision === 'passed' && !plan.syntheticOnly && rows.length > 0,
    publicationBlockers: [...(plan.syntheticOnly ? ['SYNTHETIC_ONLY'] : []),
      ...(qualityDecision === 'passed' ? [] : ['QUALITY_GATE_NOT_PASSED']), 'MODEL_NOT_ACTIVE'] };
  return V1FrozenReleaseReportSchema.parse({ ...finalBody, fingerprint: hash(finalBody) });
}
