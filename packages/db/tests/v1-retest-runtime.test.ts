import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { RetestTransitionSchema } from '@dota/contracts';
import { buildV1Features, eloLink } from '@dota/prediction';
import { computeRuntimeModelFeatures, runtimeModelSnapshot } from '../src/v1-model-runtime.js';
import { runtimeFeatureScenario } from '../src/v1-runtime.js';
import { prepareV1PerMapFeatureHistory } from '../src/v1-features.js';
import { v1Fixture } from './v1-data-fixtures.js';
import { runtimeFixture } from './v1-runtime-fixtures.js';
import { retestRegistryFixture } from './v1-retest-registry-fixture.js';
const cutoff = '2026-10-31T20:00:00.000Z';
const setup = () => {
  const source = v1Fixture();
  const history = prepareV1PerMapFeatureHistory(source), { scenario } = runtimeFixture();
  // Normalized arithmetic boundary double only. The original synthetic source cannot pass production admission.
  history.syntheticOnly = false;
  const metadata = { ...retestRegistryFixture().metadata, warmupFromAt: source.request.fromAt };
  const gate = { status: 'model_eligible' as const, kind: 'retest' as const, modelId: randomUUID(), activationEventId: randomUUID(),
    reportSha256: 'a'.repeat(64), freezeSha256: 'b'.repeat(64), runtimeSha256: 'c'.repeat(64), metadata, teamAWinProbability: null };
  return { history, scenario, gate };
};
it('uses exactly the scored Elo arithmetic and preserves side swapping without role or hero inputs', () => {
  const { history, scenario, gate } = setup();
  const expected = buildV1Features(history, runtimeFeatureScenario(history, scenario, cutoff));
  const result = computeRuntimeModelFeatures(history, scenario, cutoff, gate);
  expect(result.probability).toBe(eloLink(expected.features!.eloDifference));
  [scenario.input.lineupA, scenario.input.lineupB] = [scenario.input.lineupB, scenario.input.lineupA];
  expect(computeRuntimeModelFeatures(history, scenario, cutoff, gate).probability).toBeCloseTo(1 - result.probability!, 14);
  expect(runtimeModelSnapshot(gate)).toMatchObject({ registryFormat: 'v1-retest-registry-v1', evaluationBasis: 'conditional_retrospective_unexposed_series' });
});
it('rejects synthetic history, wrong warmup and missing identities; never substitutes a prior probability', () => {
  const { history, scenario, gate } = setup();
  expect(() => computeRuntimeModelFeatures({ ...history, syntheticOnly: true }, scenario, cutoff, gate)).toThrow('synthetic_forbidden');
  expect(() => computeRuntimeModelFeatures(history, scenario, cutoff, { ...gate, metadata: { ...gate.metadata, warmupFromAt: '2000-01-01T00:00:00.000Z' } })).toThrow('history_window');
  scenario.input.lineupA[0]!.playerId = '9999';
  expect(computeRuntimeModelFeatures(history, scenario, cutoff, gate)).toMatchObject({ probability: null, reasons: ['CURRENT_IDENTITIES_UNVERIFIED'] });
});
it('excludes completion exactly at cutoff and refuses fewer than five earlier maps', () => {
  const { history, scenario, gate } = setup();
  history.maps[5]!.completedAtUs = (BigInt(Date.parse(cutoff)) * 1000n).toString(); history.maps[5]!.fetchedAtUs = history.maps[5]!.completedAtUs;
  expect(computeRuntimeModelFeatures(history, scenario, cutoff, gate).features?.coverage.minimumPlayerMaps).toBe(5);
  history.maps[4]!.completedAtUs = history.maps[5]!.completedAtUs; history.maps[4]!.fetchedAtUs = history.maps[5]!.completedAtUs;
  expect(computeRuntimeModelFeatures(history, scenario, cutoff, gate).probability).toBeNull();
});
it('cannot accept client runtime code, probability or a malformed activation/deactivation', () => {
  const request = { requestId: randomUUID(), action: 'deactivate', modelId: null, expectedCurrentId: randomUUID(), reason: 'Owner requested deactivation', evidence: null };
  expect(RetestTransitionSchema.safeParse(request).success).toBe(true);
  for (const extra of [{ runtime: {} }, { probability: .7 }, { expectedCurrentId: null }, { action: 'promote' }])
    expect(RetestTransitionSchema.safeParse({ ...request, ...extra }).success).toBe(false);
});
