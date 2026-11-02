import { V1MetricInputSchema, type V1MetricInput } from '@dota/contracts';
import { V1_RELEASE_QUALITY_POLICY as policy } from './v1-quality-policy.js';
import { compareNumeric, compareText, hashV1 } from './v1-integrity.js';

type Row = V1MetricInput['rows'][number];
type Totals = { n: number; brier: number; logLoss: number; brierDelta: number; logLossDelta: number; p: number; y: number;
  bins: { n: number; p: number; y: number }[] };
const empty = (): Totals => ({ n: 0, brier: 0, logLoss: 0, brierDelta: 0, logLossDelta: 0, p: 0, y: 0,
  bins: Array.from({ length: 5 }, () => ({ n: 0, p: 0, y: 0 })) });
function accumulate(total: Totals, other: Totals) {
  total.n += other.n; total.brier += other.brier; total.logLoss += other.logLoss;
  total.brierDelta += other.brierDelta; total.logLossDelta += other.logLossDelta;
  total.p += other.p; total.y += other.y;
  for (let i = 0; i < 5; i++) {
    total.bins[i]!.n += other.bins[i]!.n; total.bins[i]!.p += other.bins[i]!.p; total.bins[i]!.y += other.bins[i]!.y;
  }
  return total;
}
function totals(rows: Row[]) {
  const total = empty();
  for (const row of rows) {
    const p = row.probability, y = Number(row.teamAWon), clip = policy.scoring.logLossClip;
    const clipped = Math.min(1 - clip, Math.max(clip, p));
    total.n++; total.p += p; total.y += y;
    const brier = (p - y) ** 2, logLoss = -(y * Math.log(clipped) + (1 - y) * Math.log(1 - clipped));
    total.brier += brier; total.logLoss += logLoss;
    // Pair differences per map: an identical baseline must yield exactly zero, not a rounding improvement.
    total.brierDelta += brier - policy.scoring.baselineBrier;
    total.logLossDelta += logLoss - policy.scoring.baselineLogLoss;
    let bin = 4;
    for (let i = 0; i < 4; i++) if (p < policy.calibration.bins[i + 1]!) { bin = i; break; }
    total.bins[bin]!.n++; total.bins[bin]!.p += p; total.bins[bin]!.y += y;
  }
  return total;
}
function metrics(total: Totals) {
  if (total.n === 0) return null;
  const reliability = total.bins.map((bin, index) => ({ lower: policy.calibration.bins[index]!,
    upper: policy.calibration.bins[index + 1]!, upperInclusive: index === 4, n: bin.n,
    meanProbability: bin.n ? bin.p / bin.n : null, observedWinRate: bin.n ? bin.y / bin.n : null }));
  const brier = total.brier / total.n, logLoss = total.logLoss / total.n;
  return { n: total.n, brier, logLoss, baselineBrier: policy.scoring.baselineBrier,
    baselineLogLoss: policy.scoring.baselineLogLoss,
    brierDelta: total.brierDelta / total.n, logLossDelta: total.logLossDelta / total.n,
    meanProbability: total.p / total.n, observedWinRate: total.y / total.n,
    meanProbabilityGap: Math.abs(total.p - total.y) / total.n,
    ece: total.bins.reduce((sum, b) => sum + Math.abs(b.p - b.y), 0) / total.n, reliability };
}
const seriesOrder = (a: string, b: string) => {
  const [ap, ai] = a.split(':'), [bp, bi] = b.split(':');
  return compareText(ap!, bp!) || compareNumeric(ai!, bi!);
};
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const upper95 = (values: number[]) => {
  values.sort((a, b) => a - b);
  const index = (values.length - 1) * policy.uncertainty.upperQuantile, floor = Math.floor(index);
  return values[floor]! + (values[Math.ceil(index)]! - values[floor]!) * (index - floor);
};
function bootstrap(groups: Totals[]) {
  const random = rng(policy.uncertainty.seed), brier: number[] = [], logLoss: number[] = [], ece: number[] = [];
  for (let draw = 0; draw < policy.uncertainty.resamples; draw++) {
    const sampled = empty();
    for (let i = 0; i < groups.length; i++) accumulate(sampled, groups[Math.floor(random() * groups.length)]!);
    // Scores are map-weighted; whole series are sampled together and paired with the baseline.
    brier.push(sampled.brierDelta / sampled.n);
    logLoss.push(sampled.logLossDelta / sampled.n);
    ece.push(sampled.bins.reduce((sum, b) => sum + Math.abs(b.p - b.y), 0) / sampled.n);
  }
  return { method: policy.uncertainty.method, resamples: policy.uncertainty.resamples, seed: policy.uncertainty.seed,
    brierDeltaUpper95: upper95(brier), logLossDeltaUpper95: upper95(logLoss), eceUpper95: upper95(ece) };
}

/** Unbound diagnostic kernel. It cannot verify sources, select a test, freeze a run or approve a release. */
export function evaluateV1MetricDiagnostic(input: unknown) {
  const base = { schemaVersion: 1, format: 'v1-metric-diagnostic-v1', qualityPolicySha256: hashV1(policy),
    sourceEvidence: 'not_bound', releaseGatePassed: false, deployable: false, teamAWinProbability: null };
  const invalid = (reason: string) => ({ ...base, metricGateDecision: 'unavailable', reasons: [reason],
    coverage: null, metrics: null, uncertainty: null, stability: null, syntheticOnly: null });
  const parsed = V1MetricInputSchema.safeParse(input);
  if (!parsed.success) return invalid('INVALID_METRIC_INPUT');
  const { ledger, rows, syntheticOnly } = parsed.data;
  if (new Set(ledger.map(r => r.matchId)).size !== ledger.length || new Set(rows.map(r => r.matchId)).size !== rows.length)
    return invalid('DUPLICATE_MAP');
  const byId = new Map(ledger.map(r => [r.matchId, r]));
  if (ledger.some(r => r.disposition === 'scored' ? r.seriesKey === null || r.reasons.length > 0 : r.reasons.length === 0) ||
    rows.length !== ledger.filter(r => r.disposition === 'scored').length || rows.some(r => {
      const entry = byId.get(r.matchId); return !entry || entry.disposition !== 'scored' || entry.seriesKey !== r.seriesKey;
    })) return invalid('LEDGER_SCORE_MISMATCH');
  const scoredSeries = new Set(rows.map(r => r.seriesKey));
  if (ledger.some(r => r.disposition === 'excluded' && r.seriesKey !== null && scoredSeries.has(r.seriesKey)))
    return invalid('PARTIAL_KNOWN_SERIES');
  const observedSeries = new Set(ledger.flatMap(r => r.seriesKey ?? []));
  const coverage = { observedMaps: ledger.length, scoredMaps: rows.length, observedKnownSeries: observedSeries.size,
    scoredSeries: scoredSeries.size, mapCoverage: ledger.length ? rows.length / ledger.length : null,
    knownSeriesCoverage: observedSeries.size ? scoredSeries.size / observedSeries.size : null };
  const bySeries = new Map<string, Row[]>();
  for (const row of rows) { const group = bySeries.get(row.seriesKey) ?? []; group.push(row); bySeries.set(row.seriesKey, group); }
  const groups = [...bySeries].sort(([a], [b]) => seriesOrder(a, b)).map(([key, maps]) => {
    maps.sort((a, b) => compareNumeric(a.startedAtUs, b.startedAtUs) || compareNumeric(a.matchId, b.matchId));
    return { key, startedAtUs: maps[0]!.startedAtUs, totals: totals(maps) };
  });
  const overall = metrics(groups.reduce((sum, g) => accumulate(sum, g.totals), empty()));
  const temporal = [...groups].sort((a, b) => compareNumeric(a.startedAtUs, b.startedAtUs) || compareText(a.key, b.key));
  const midpoint = Math.floor(temporal.length / 2);
  const stability = [temporal.slice(0, midpoint), temporal.slice(midpoint)].map((half, index) => ({
    half: index + 1, series: half.length, seriesKeys: half.map(g => g.key),
    metrics: metrics(half.reduce((sum, g) => accumulate(sum, g.totals), empty()))
  }));
  const reasons: string[] = [];
  if (rows.length < policy.sample.minMaps) reasons.push('MIN_MAPS');
  if (groups.length < policy.sample.minSeries) reasons.push('MIN_SERIES');
  if (coverage.mapCoverage === null || coverage.mapCoverage < policy.sample.minMapCoverage) reasons.push('MAP_COVERAGE');
  if (coverage.knownSeriesCoverage === null || coverage.knownSeriesCoverage < policy.sample.minKnownSeriesCoverage) reasons.push('SERIES_COVERAGE');
  if (stability.some(h => h.series < policy.stability.minSeriesPerHalf || (h.metrics?.n ?? 0) < policy.stability.minMapsPerHalf))
    reasons.push('STABILITY_SAMPLE');
  if (reasons.length || overall === null) return { ...base, metricGateDecision: 'insufficient_evidence', reasons,
    coverage, metrics: overall, uncertainty: null, stability, syntheticOnly };
  const uncertainty = bootstrap(groups.map(g => g.totals));
  if (overall.brier > policy.scoring.maxBrier) reasons.push('BRIER');
  if (overall.logLoss > policy.scoring.maxLogLoss) reasons.push('LOG_LOSS');
  if (uncertainty.brierDeltaUpper95 >= policy.scoring.maxBrierDeltaUpper95) reasons.push('BRIER_BASELINE_UPPER');
  if (uncertainty.logLossDeltaUpper95 >= policy.scoring.maxLogLossDeltaUpper95) reasons.push('LOG_LOSS_BASELINE_UPPER');
  if (overall.ece > policy.calibration.maxEce) reasons.push('ECE');
  if (uncertainty.eceUpper95 > policy.calibration.maxEceUpper95) reasons.push('ECE_UPPER');
  if (overall.meanProbabilityGap > policy.calibration.maxAbsoluteMeanProbabilityMinusWinRate) reasons.push('MEAN_PROBABILITY_GAP');
  if (stability.some(h => h.metrics!.brierDelta > policy.stability.maxBrierDeltaPerHalf ||
    h.metrics!.logLossDelta > policy.stability.maxLogLossDeltaPerHalf)) reasons.push('STABILITY_METRICS');
  return { ...base, metricGateDecision: reasons.length ? 'failed' : 'passed', reasons,
    coverage, metrics: overall, uncertainty, stability, syntheticOnly };
}
