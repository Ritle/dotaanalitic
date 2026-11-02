import { expect, it } from 'vitest';
import { buildV1Features, V1_FEATURE_POLICY } from '@dota/prediction';
import { prepareV1Data } from '../src/v1-data.js';
import { buildV1DevelopmentFeatures, prepareV1FeatureHistory } from '../src/v1-features.js';
import { V1_RELEASE_QUALITY_POLICY } from '../src/v1-release-plan.js';
import { v1Fixture } from './v1-data-fixtures.js';

it('adapts verified native slots and produces the exact same features through the runtime entry point', () => {
  const dataset = prepareV1Data(v1Fixture()), original = JSON.stringify(dataset);
  const history = prepareV1FeatureHistory(dataset), output = buildV1DevelopmentFeatures(dataset);
  expect(output.summary).toEqual({ maps: 6, featureReady: 1, unavailable: 5 });
  for (const row of output.rows) {
    expect(row.result).toEqual(buildV1Features(history, row.result.scenario));
    const example = dataset.report.examples.find(e => e.matchId === row.matchId)!;
    expect(row.result.teamA.map(p => p.playerId).sort()).toEqual([...example.inputs.teamAPlayerIds].sort());
    expect(row.result.coverage.minimumPlayerMaps).toBe(Math.min(...example.historyCoverage.priorMapsPerPlayer));
  }
  expect(JSON.stringify(dataset)).toBe(original);
  expect(JSON.stringify(output)).not.toMatch(/"teamAWon"|"radiantWin"|"payloadSha256"/);
  expect(output.deployable).toBe(false); expect(output.teamAWinProbability).toBeNull();
});
it('pins the builder to the already registered V1 policy without editing it', () => {
  const release = V1_RELEASE_QUALITY_POLICY;
  expect(V1_FEATURE_POLICY.version).toBe(release.model.featureProfile);
  expect(V1_FEATURE_POLICY.initialRating).toBe(release.model.initialRating);
  expect(V1_FEATURE_POLICY.k).toBe(release.model.k); expect(V1_FEATURE_POLICY.scale).toBe(release.model.scale);
  expect(V1_FEATURE_POLICY.minCompletedProMapsPerPlayer).toBe(release.history.minCompletedProMapsPerPlayer);
  expect(V1_FEATURE_POLICY.cutoff).toBe(release.history.cutoff);
  expect(V1_FEATURE_POLICY.identity).toBe(release.history.identity);
});
it('preserves real fact/identity clocks rather than turning a current proof into a historical proof', () => {
  const dataset = prepareV1Data(v1Fixture()), history = prepareV1FeatureHistory(dataset);
  expect(history.maps[0]!.factClocks).toEqual(dataset.source.candidates[0]!.facts);
  expect(history.identities).toEqual(dataset.source.identities);
  expect(history.maps[0]!.factClocks[0]!.knownAtUs).toBeNull();
  expect(BigInt(history.maps[0]!.fetchedAtUs)).toBeGreaterThan(BigInt(history.maps[0]!.completedAtUs));
});
it('re-verifies immutable dataset eligibility and keeps invalid whole series out of history', () => {
  const source = v1Fixture(); source.candidates[0]!.isPro = false;
  const dataset = prepareV1Data(source), history = prepareV1FeatureHistory(dataset);
  expect(history.maps).toHaveLength(5);
  expect(history.maps.some(m => m.matchId === source.candidates[0]!.matchId)).toBe(false);
  dataset.report.summary.eligibleMaps++;
  expect(() => prepareV1FeatureHistory(dataset)).toThrow('v1_dataset_fingerprint_mismatch');
});
it('keeps earlier numeric features invariant under later labels, while source provenance changes', () => {
  const source = v1Fixture(), first = buildV1DevelopmentFeatures(prepareV1Data(source));
  const last = source.candidates.at(-1)!; last.radiantWin = !last.radiantWin;
  if (last.outcome.status === 'verified') last.outcome.teamAWon = last.radiantWin;
  const second = buildV1DevelopmentFeatures(prepareV1Data(source));
  expect(second.sourceFingerprint).not.toBe(first.sourceFingerprint);
  expect(second.rows.map(r => [r.result.features, r.result.teamA, r.result.teamB, r.result.coverage]))
    .toEqual(first.rows.map(r => [r.result.features, r.result.teamA, r.result.teamB, r.result.coverage]));
});
it('keeps V1 release and E1 research exports outside the development-feature CLI boundary', () => {
  expect(() => buildV1DevelopmentFeatures({ schemaVersion: 1, format: 'research-elo-export-v1' })).toThrow();
  expect(() => buildV1DevelopmentFeatures({ schemaVersion: 1, format: 'v1-release-plan-v1' })).toThrow();
});
