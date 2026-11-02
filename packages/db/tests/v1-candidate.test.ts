import { expect, it } from 'vitest';
import { createV1CandidateDiagnosticScorer, verifyV1Candidate, V1_RELEASE_QUALITY_POLICY } from '@dota/prediction';
import { registerV1Candidate, verifyRegisteredV1Candidate } from '../src/v1-candidate.js';
import { planV1Release } from '../src/v1-release-plan.js';
import { prepareV1FeatureHistory, buildV1DevelopmentFeatures } from '../src/v1-features.js';
import { releasePlanFixture } from './v1-release-plan-fixtures.js';
import { canonicalContextJson } from '../src/temporal.js';
import { createHash } from 'node:crypto';
const hash = (value: unknown) => createHash('sha256').update(canonicalContextJson(value)).digest('hex');
function setup() {
  const f = releasePlanFixture(), plan = planV1Release(f.request, f.catalogue, f.development, f.registeredAt);
  const code = [{ path: 'synthetic/kernel.js', sha256: 'a'.repeat(64) }], sha = 'b'.repeat(64), at = '2026-11-02T00:00:00.000Z';
  const candidate = registerV1Candidate(plan, f.catalogue, f.development, sha, code, at);
  return { ...f, plan, code, sha, at, candidate };
}
it('registers an inactive fixed policy bound to plan/data/code with arithmetic parity, never a model activation', () => {
  const f = setup(), c = f.candidate;
  expect(c.registration.qualityPolicySha256).toBe(hash(V1_RELEASE_QUALITY_POLICY));
  expect(c.registration.developmentFingerprint).toBe(f.development.fingerprint);
  expect(c.fit).toMatchObject({ method: 'fixed_policy_no_fitting', trainingRunId: null, seed: null });
  expect(c.inference.featureOrder).toEqual(['eloDifference']); expect(c.parity.probes).toHaveLength(5);
  expect(c.qualityGate).toBe('not_evaluated'); expect(c.isActive).toBe(false); expect(c.deployable).toBe(false);
  expect(c.executableFreeze.complete).toBe(false);
  expect(verifyRegisteredV1Candidate(c, f.plan, f.catalogue, f.development, f.sha, f.code)).toEqual(c);
});
it('reproduces a saved candidate exactly without adopting changed code, plan or data bindings', () => {
  const f = setup();
  expect(verifyV1Candidate(f.candidate, f.candidate.registration)).toEqual(f.candidate);
  expect(() => verifyRegisteredV1Candidate(f.candidate, f.plan, f.catalogue, f.development, f.sha,
    [{ ...f.code[0]!, sha256: 'c'.repeat(64) }])).toThrow('v1_candidate_replay_mismatch');
  expect(() => verifyRegisteredV1Candidate(f.candidate, f.plan, f.catalogue, f.development, 'd'.repeat(64), f.code)).toThrow();
  const changed = structuredClone(f.plan); changed.qualityPolicy.scoring.maxBrier = 0.5 as 0.245;
  expect(() => verifyRegisteredV1Candidate(f.candidate, changed, f.catalogue, f.development, f.sha, f.code)).toThrow('release_plan_replay_mismatch');
});
it('rejects forged activation, parameters, calibrator, parity probes and a recomputed inner fingerprint', () => {
  const f = setup();
  for (const change of [
    (c: typeof f.candidate) => { c.isActive = true; },
    (c: typeof f.candidate) => { c.inference.scale = 800; },
    (c: typeof f.candidate) => { c.inference.fittedCalibrator = true; },
    (c: typeof f.candidate) => { c.parity.probes[0]!.expected = 0.2; }
  ]) {
    const altered = structuredClone(f.candidate); change(altered);
    const { fingerprint: _old, ...body } = altered; altered.fingerprint = hash(body);
    expect(() => verifyV1Candidate(altered, f.candidate.registration)).toThrow('v1_candidate_replay_mismatch');
  }
});
it('checks registration strictly before the first test start and after the registered plan', () => {
  const f = setup();
  expect(() => registerV1Candidate(f.plan, f.catalogue, f.development, f.sha, f.code, f.plan.testFromAt)).toThrow();
  expect(() => registerV1Candidate(f.plan, f.catalogue, f.development, f.sha, f.code, '2026-10-31T00:00:00.000Z')).toThrow();
  expect(() => registerV1Candidate(f.plan, f.catalogue, f.development, f.sha, [...f.code, ...f.code], f.at)).toThrow();
});
it('uses the shared feature builder for synthetic diagnostic inference; cold starts return null', () => {
  const f = setup(), history = prepareV1FeatureHistory(f.development);
  const features = buildV1DevelopmentFeatures(f.development), score = createV1CandidateDiagnosticScorer(f.candidate, f.candidate.registration);
  const ready = features.rows.at(-1)!.result, result = score(history, ready.scenario);
  expect(result.evaluationProbability).toBeCloseTo(1 / (1 + 10 ** (-ready.features!.eloDifference / 400)), 14);
  expect(result.featureFingerprint).toBe(ready.fingerprint); expect(result.teamAWinProbability).toBeNull();
  expect(score(history, features.rows[0]!.result.scenario).evaluationProbability).toBeNull();
  const swap = score(history, { ...ready.scenario, teamA: ready.scenario.teamB, teamB: ready.scenario.teamA });
  expect(swap.evaluationProbability! + result.evaluationProbability!).toBeCloseTo(1, 14);
  expect(() => score({ ...history, syntheticOnly: false }, ready.scenario)).toThrow('v1_candidate_synthetic_mismatch');
  expect(() => score({ ...history, warmupFromAtUs: '1' }, ready.scenario)).toThrow('v1_candidate_history_window_mismatch');
});
it('rejects unknown and tampered artifacts before any feature calculation', () => {
  const f = setup();
  expect(() => createV1CandidateDiagnosticScorer({ isActive: true }, f.candidate.registration)).toThrow();
  expect(() => verifyRegisteredV1Candidate(null, f.plan, f.catalogue, f.development, f.sha, f.code)).toThrow();
  expect(() => verifyRegisteredV1Candidate(f.candidate, f.plan, f.catalogue, { ...f.development, fingerprint: '0'.repeat(64) }, f.sha, f.code)).toThrow();
});
