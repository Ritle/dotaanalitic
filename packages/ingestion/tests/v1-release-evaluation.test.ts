import { expect, it } from 'vitest';
import { releaseJournalFixture } from './v1-release-evaluation-fixtures.js';
import { freezeV1ReleaseCapture, prepareV1ReleaseEvidence } from '../src/v1-release-evidence.js';
import { evaluateV1ReleaseCapture } from '../src/v1-release-evaluation.js';
import { freezeV1ReleaseInventory, prepareReleaseHistory } from '../../db/src/v1-release-inventory.js';
import { buildV1Features } from '../../prediction/src/v1-features.js';
const evaluate = (f: ReturnType<typeof releaseJournalFixture>) => {
  const capture = freezeV1ReleaseCapture(f.plan, f.candidate, f.inventory, f.ledger, f.batches,
    f.plan.evaluateNotBefore, f.files, 'e'.repeat(64), f.code);
  return evaluateV1ReleaseCapture(f.plan, f.candidate, capture, f.ledger, f.batches, f.plan.evaluateNotBefore);
};
const refreeze = (f: ReturnType<typeof releaseJournalFixture>) => {
  const { fingerprint: _old, ...body } = f.inventory; f.inventory = freezeV1ReleaseInventory(body);
};
it('scores only verified targets, matches shared Elo, and retains insufficient evidence without activation', () => {
  const f = releaseJournalFixture('metrics'), report = evaluate(f);
  expect(report).toMatchObject({ coverage: { observedTargetMaps: 2, scoredMaps: 2 },
    evaluation: { status: 'evaluation_complete', qualityDecision: 'insufficient_evidence', syntheticOnly: true,
      metrics: { n: 2 } }, releaseGatePassed: false, deployable: false, teamAWinProbability: null });
  expect(evaluate(f)).toEqual(report);
  const history = prepareReleaseHistory(f.inventory).history, map = history.maps.find(m => m.matchId === '201')!;
  const feature = buildV1Features(history, { schemaVersion: 1, targetMatchId: '201', cutoffAtUs: map.startedAtUs,
    teamA: map.teamA, teamB: map.teamB, lineup: { basis: 'actual_lineup_reconstructed', source: 'synthetic',
      selectedAtUs: map.fetchedAtUs, revision: 'synthetic' } });
  const rows = report.scoredRows as { probability: number; teamAWon: boolean }[];
  expect(rows[0]!.probability).toBeCloseTo(1 / (1 + 10 ** (-feature.features!.eloDifference / 400)), 14);
  const brier = rows.reduce((sum, r) => sum + (r.probability - Number(r.teamAWon)) ** 2, 0) / rows.length;
  expect(report.evaluation.metrics).toMatchObject({ brier });
});
it('missing targets remain in coverage, and zero scorable maps yield null metrics', () => {
  const f = releaseJournalFixture('missing');
  f.inventory.source.candidates = f.inventory.source.candidates.filter(m => m.matchId !== '201');
  f.inventory.metadata = f.inventory.metadata.filter(m => m.matchId !== '201'); refreeze(f);
  expect(evaluate(f)).toMatchObject({ coverage: { observedTargetMaps: 2, scoredMaps: 1, mapCoverage: 0.5 } });
  f.inventory.source.candidates = f.inventory.source.candidates.filter(m => m.matchId !== '202');
  f.inventory.metadata = f.inventory.metadata.filter(m => m.matchId !== '202'); refreeze(f);
  expect(evaluate(f)).toMatchObject({ coverage: { observedTargetMaps: 2, scoredMaps: 0 },
    evaluation: { status: 'unavailable', metrics: null, qualityDecision: 'insufficient_evidence' } });
});
it('reconstructs opposite A orientation for both probability and label', () => {
  const f = releaseJournalFixture('orientation'), before = evaluate(f).scoredRows as { matchId: string; probability: number; teamAWon: boolean }[];
  const map = f.inventory.source.candidates.find(m => m.matchId === '201')!;
  map.radiantTeamId = '33'; if (map.outcome.status === 'verified') map.outcome.teamAId = '33';
  f.inventory.source.aliases.find(a => a.seriesId === map.seriesId)!.teamAId = '33'; refreeze(f);
  const after = evaluate(f).scoredRows as typeof before;
  expect(after[0]!.probability).toBeCloseTo(1 - before[0]!.probability, 14);
  expect(after[0]!.teamAWon).toBe(!before[0]!.teamAWon);
});
it('keeps all conflicting series aliases in the source denominator, beyond the kernel one-key representation', () => {
  const f = releaseJournalFixture('aliases'), map = f.inventory.source.candidates.find(m => m.matchId === '201')!;
  f.inventory.source.aliases.find(a => a.seriesId === map.seriesId)!.providerSeriesId = '991'; refreeze(f);
  const binding = prepareV1ReleaseEvidence(f.plan, f.candidate, f.inventory, f.ledger, f.batches);
  expect(binding.coverage.observedKnownSeries).toBe(3);
  expect(evaluate(f)).toMatchObject({ coverage: { observedKnownSeries: 3, scoredSeries: 1, knownSeriesCoverage: 1 / 3 },
    evaluation: { reasons: expect.arrayContaining(['SOURCE_SERIES_COVERAGE']) } });
});
it('rejects early scoring and tampered capture bindings before producing any report', () => {
  const f = releaseJournalFixture('guard');
  expect(() => evaluateV1ReleaseCapture(f.plan, f.candidate, null, f.ledger, f.batches, f.at)).toThrow('release_capture_too_early');
  expect(() => evaluateV1ReleaseCapture(f.plan, f.candidate, { ...f.capture, bindingFingerprint: '0'.repeat(64) },
    f.ledger, f.batches, f.plan.evaluateNotBefore)).toThrow('release_capture_replay_mismatch');
});
