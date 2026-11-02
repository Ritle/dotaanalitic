import { describe, expect, it } from 'vitest';
import type { V1MetricInput } from '@dota/contracts';
import { evaluateV1MetricDiagnostic, V1_RELEASE_QUALITY_POLICY } from '../src/index.js';

function fixture(): V1MetricInput {
  const rows = Array.from({ length: 200 }, (_, i) => ({ matchId: String(9007199254741000n + BigInt(i)),
    seriesKey: 'opendota:' + (Math.floor(i / 5) + 1), startedAtUs: String(1000000 + i), probability: 0.8, teamAWon: i % 5 !== 4 }));
  return { schemaVersion: 1, purpose: 'unbound_metric_diagnostic', syntheticOnly: true, rows,
    ledger: rows.map(r => ({ matchId: r.matchId, seriesKey: r.seriesKey, disposition: 'scored', reasons: [] })) };
}
describe('preregistered V1 metric diagnostic, never a release authorization', () => {
  it('matches hand-computed calibration/Brier/log loss and identical-series bootstrap', () => {
    const result = evaluateV1MetricDiagnostic(fixture());
    expect(result.metricGateDecision).toBe('passed');
    expect(result.metrics!.brier).toBeCloseTo(0.16, 12);
    expect(result.metrics!.logLoss).toBeCloseTo(-0.8 * Math.log(0.8) - 0.2 * Math.log(0.2), 12);
    expect(result.metrics!.ece).toBeCloseTo(0, 12);
    expect(result.uncertainty!.brierDeltaUpper95).toBeCloseTo(-0.09, 12);
    expect(result.uncertainty!.logLossDeltaUpper95).toBeCloseTo(result.metrics!.logLossDelta, 12);
    expect(result.uncertainty!.eceUpper95).toBeCloseTo(0, 12);
    expect(result.metrics!.reliability[4]).toMatchObject({ lower: 0.8, upper: 1, n: 200, upperInclusive: true });
    expect(result.metrics!.reliability[0]!.observedWinRate).toBeNull();
    expect(result.releaseGatePassed).toBe(false); expect(result.sourceEvidence).toBe('not_bound');
    expect(result.deployable).toBe(false); expect(result.teamAWinProbability).toBeNull();
  });
  it('uses fixed seeded whole-series sampling with map weights for unequal series sizes', () => {
    const input = fixture(); input.rows = [];
    let id = 1;
    for (let series = 1; series <= 40; series++) {
      const large = series % 2 === 0;
      for (let map = 0; map < (large ? 9 : 1); map++) input.rows.push({ matchId: String(id++),
        seriesKey: 'opendota:' + series, startedAtUs: String(series * 100 + map), probability: large ? 0.2 : 0.8, teamAWon: map === 0 });
    }
    input.ledger = input.rows.map(r => ({ matchId: r.matchId, seriesKey: r.seriesKey, disposition: 'scored', reasons: [] }));
    const result = evaluateV1MetricDiagnostic(input);
    expect(result.metrics!.brier).toBeCloseTo(0.1, 12);
    // Forty draws of one of two whole-series shapes: seeded 95th percentile has 25 large groups;
    // ECE decreases with their count, so its upper quantile has 15. Never sample 200 independent maps.
    expect(result.uncertainty!.brierDeltaUpper95).toBeCloseTo((15 * 0.04 + 25 * 0.96) / 240 - 0.25, 12);
    expect(result.uncertainty!.logLossDeltaUpper95).toBeCloseTo(
      (15 * -Math.log(0.8) + 25 * (-Math.log(0.2) - 8 * Math.log(0.8))) / 240 - Math.log(2), 12);
    expect(result.uncertainty!.eceUpper95).toBeCloseTo((25 * 0.2 + 15 * 0.8) / 160, 12);
    input.rows.reverse(); input.ledger.reverse(); expect(evaluateV1MetricDiagnostic(input)).toEqual(result);
  });
  it('uses left-closed bins, includes one in the final bin and clips only log loss', () => {
    const input = fixture(); input.rows = input.rows.slice(0, 6);
    input.rows.forEach((r, i) => { r.probability = [0, 0.2, 0.4, 0.6, 0.8, 1][i]!; r.teamAWon = i === 0; });
    input.ledger = input.rows.map(r => ({ matchId: r.matchId, seriesKey: r.seriesKey, disposition: 'scored', reasons: [] }));
    const result = evaluateV1MetricDiagnostic(input);
    expect(result.metrics!.reliability.map(b => b.n)).toEqual([1, 1, 1, 1, 2]);
    expect(Number.isFinite(result.metrics!.logLoss)).toBe(true);
    expect(result.metrics!.brier).toBeCloseTo((1 + 0.04 + 0.16 + 0.36 + 0.64 + 1) / 6, 12);
    expect(result.metricGateDecision).toBe('insufficient_evidence'); expect(result.uncertainty).toBeNull();
  });
  it('keeps missing/unknown targets in denominators and checks exact 80% boundary', () => {
    const input = fixture();
    for (let i = 0; i < 50; i++) input.ledger.push({ matchId: String(10000 + i), seriesKey: 'opendota:' + (100 + Math.floor(i / 5)),
      disposition: 'excluded', reasons: ['MISSING_DETAIL'] });
    expect(evaluateV1MetricDiagnostic(input).metricGateDecision).toBe('passed');
    input.ledger.push({ matchId: '50000', seriesKey: null, disposition: 'excluded', reasons: ['UNKNOWN_SERIES'] });
    const result = evaluateV1MetricDiagnostic(input);
    expect(result.metricGateDecision).toBe('insufficient_evidence'); expect(result.reasons).toContain('MAP_COVERAGE');
    expect(result.coverage!.observedMaps).toBe(251); expect(result.coverage!.knownSeriesCoverage).toBe(0.8);
  });
  it('returns null rates/metrics for zero observations', () => {
    const result = evaluateV1MetricDiagnostic({ ...fixture(), ledger: [], rows: [] });
    expect(result.metrics).toBeNull(); expect(result.coverage!.mapCoverage).toBeNull();
    expect(result.coverage!.knownSeriesCoverage).toBeNull(); expect(result.uncertainty).toBeNull();
  });
  it('requires strictly better baseline upper bounds; a 50/50 baseline does not pass', () => {
    const input = fixture(); input.rows.forEach(r => { r.probability = 0.5; });
    const result = evaluateV1MetricDiagnostic(input);
    expect(result.metricGateDecision).toBe('failed'); expect(result.uncertainty!.brierDeltaUpper95).toBe(0);
    expect(result.reasons).toContain('BRIER_BASELINE_UPPER'); expect(result.reasons).toContain('LOG_LOSS_BASELINE_UPPER');
  });
  it('rejects duplicate IDs, partial known series and ledger/score mismatches before metrics', () => {
    const input = fixture(); input.rows.push(input.rows[0]!);
    expect(evaluateV1MetricDiagnostic(input).reasons).toEqual(['DUPLICATE_MAP']); input.rows.pop();
    input.ledger.push({ matchId: '50000', seriesKey: input.rows[0]!.seriesKey, disposition: 'excluded', reasons: ['COLD_START'] });
    expect(evaluateV1MetricDiagnostic(input).reasons).toEqual(['PARTIAL_KNOWN_SERIES']); input.ledger.pop();
    input.rows[0]!.seriesKey = 'opendota:999';
    expect(evaluateV1MetricDiagnostic(input).reasons).toEqual(['LEDGER_SCORE_MISMATCH']);
  });
  it.each([NaN, Infinity, -0.1, 1.1])('fails closed for invalid probability %s', value => {
    const input = fixture(); input.rows[0]!.probability = value;
    const result = evaluateV1MetricDiagnostic(input); expect(result.metricGateDecision).toBe('unavailable'); expect(result.metrics).toBeNull();
  });
  it('checks temporal half sample sizes and does not repartition maps to repair a small half', () => {
    const input = fixture();
    input.rows = input.rows.filter(r => Number(r.seriesKey.split(':')[1]) > 20 || BigInt(r.matchId) % 5n === 0n);
    input.ledger = input.rows.map(r => ({ matchId: r.matchId, seriesKey: r.seriesKey, disposition: 'scored', reasons: [] }));
    const result = evaluateV1MetricDiagnostic(input);
    expect(result.coverage!.scoredSeries).toBe(40); expect(result.reasons).toContain('STABILITY_SAMPLE');
    expect(result.stability![0]!.metrics!.n).toBe(20); expect(result.uncertainty).toBeNull();
  });
  it('rejects a poor temporal half even when the full sample meets counts', () => {
    const input = fixture();
    input.rows.filter(r => Number(r.seriesKey.split(':')[1]) <= 20).forEach(r => { r.probability = 0.1; });
    const result = evaluateV1MetricDiagnostic(input);
    expect(result.metricGateDecision).toBe('failed'); expect(result.reasons).toContain('STABILITY_METRICS');
  });
  it('does not allow callers to change the preregistered thresholds or seed at runtime', () => {
    expect(Object.isFrozen(V1_RELEASE_QUALITY_POLICY)).toBe(true);
    expect(Object.isFrozen(V1_RELEASE_QUALITY_POLICY.uncertainty)).toBe(true);
    expect(() => Object.assign(V1_RELEASE_QUALITY_POLICY.scoring, { maxBrier: 1 })).toThrow();
    expect(() => Object.assign(V1_RELEASE_QUALITY_POLICY.calibration.bins, { 1: 0.5 })).toThrow();
  });
});
