import { V1CandidateRegistrationSchema } from '@dota/contracts';
import { buildV1Features, V1_FEATURE_POLICY } from './v1-features.js';
import { V1_RELEASE_QUALITY_POLICY } from './v1-quality-policy.js';
import { canonicalV1Json, compareText, hashV1 } from './v1-integrity.js';

/** Shared fixed inference arithmetic; this primitive does not grant publication authority. */
export function eloLink(difference: number) {
  if (!Number.isFinite(difference)) throw Error('v1_candidate_nonfinite_feature');
  return 1 / (1 + 10 ** (-difference / V1_FEATURE_POLICY.scale));
}
// Independent arithmetic probes, not matches, training examples or user forecasts.
const golden = () => [
  { difference: -800, expected: 1 / 101 }, { difference: -400, expected: 1 / 11 },
  { difference: 0, expected: 0.5 }, { difference: 400, expected: 10 / 11 },
  { difference: 800, expected: 100 / 101 }
];

export function createV1Candidate(registrationInput: unknown) {
  const registration = V1CandidateRegistrationSchema.parse(registrationInput);
  if (registration.qualityPolicySha256 !== hashV1(V1_RELEASE_QUALITY_POLICY)) throw Error('v1_candidate_quality_policy_mismatch');
  const policy = V1_RELEASE_QUALITY_POLICY;
  if (V1_FEATURE_POLICY.version !== policy.model.featureProfile || V1_FEATURE_POLICY.k !== policy.model.k ||
    V1_FEATURE_POLICY.initialRating !== policy.model.initialRating || V1_FEATURE_POLICY.scale !== policy.model.scale ||
    V1_FEATURE_POLICY.minCompletedProMapsPerPlayer !== policy.history.minCompletedProMapsPerPlayer ||
    V1_FEATURE_POLICY.cutoff !== policy.history.cutoff || V1_FEATURE_POLICY.identity !== policy.history.identity) {
    throw Error('v1_candidate_feature_policy_mismatch');
  }
  registration.code.sort((a, b) => compareText(a.path, b.path));
  const probes = golden();
  if (probes.some(p => Math.abs(eloLink(p.difference) - p.expected) > 1e-14)) throw Error('v1_candidate_parity_failed');
  const body = { schemaVersion: 1 as const, format: 'v1-fixed-elo-candidate-v1' as const,
    stage: 'pre_match' as const, model: 'fixed_player_mean_elo' as const, registration,
    featurePolicy: structuredClone(V1_FEATURE_POLICY),
    inference: { featureOrder: ['eloDifference'], link: 'base10_elo_logistic', scale: 400,
      preprocessing: 'none', fittedCalibrator: false, sideAdvantage: false },
    qualityPolicySha256: hashV1(policy), codeFingerprint: hashV1(registration.code),
    parity: { purpose: 'synthetic_arithmetic_probes_only', absoluteTolerance: 1e-14, probes },
    fit: { method: 'fixed_policy_no_fitting', trainingRunId: null, seed: null,
      developmentUse: 'provenance_only_not_a_release_test' },
    qualityGate: 'not_evaluated', isActive: false, deployable: false, teamAWinProbability: null,
    executableFreeze: { kernelOnly: true, releaseEvidenceExecutorBound: false, complete: false } };
  return { ...body, fingerprint: hashV1(body) };
}

/** Compare to external trusted plan/code bindings; a self-recomputed artifact hash is not authority. */
export function verifyV1Candidate(input: unknown, expectedRegistration: unknown) {
  const expected = createV1Candidate(expectedRegistration);
  if (canonicalV1Json(input) !== canonicalV1Json(expected)) throw Error('v1_candidate_replay_mismatch');
  return expected;
}

/** Internal evaluation primitive only. No public forecast/activation API; caller must bind verified targets. */
export function createV1CandidateDiagnosticScorer(input: unknown, expectedRegistration: unknown) {
  const candidate = verifyV1Candidate(input, expectedRegistration);
  return (history: unknown, scenario: unknown) => {
    const result = buildV1Features(history, scenario);
    const expectedWarmup = (BigInt(Date.parse(candidate.registration.warmupFromAt)) * 1000n).toString();
    if (result.history.warmupFromAtUs !== expectedWarmup) throw Error('v1_candidate_history_window_mismatch');
    if (result.syntheticOnly !== candidate.registration.syntheticOnly) throw Error('v1_candidate_synthetic_mismatch');
    return { purpose: 'unbound_metric_diagnostic', candidateFingerprint: candidate.fingerprint,
      featureFingerprint: result.fingerprint, status: result.status, reasons: result.reasons,
      evaluationProbability: result.features === null ? null : eloLink(result.features.eloDifference),
      releaseGatePassed: false, deployable: false, teamAWinProbability: null };
  };
}
