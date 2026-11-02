import { createHash } from 'node:crypto';
import { V1CandidateRegistrationSchema } from '@dota/contracts';
import { createV1Candidate, verifyV1Candidate } from '@dota/prediction';
import { verifyV1ReleasePlan } from './v1-release-plan.js';
import { canonicalContextJson } from './temporal.js';
const hash = (value: unknown) => createHash('sha256').update(canonicalContextJson(value)).digest('hex');

/** Source file SHAs are externally checked by the CLI before this replay of all plan evidence. */
export function registerV1Candidate(planInput: unknown, catalogue: unknown, development: unknown,
  planSha256: string, code: unknown, kernelRegisteredAt: string) {
  const plan = verifyV1ReleasePlan(planInput, catalogue, development);
  return createV1Candidate({ kernelRegisteredAt, planRegisteredAt: plan.registeredAt, planSha256,
    planFingerprint: plan.fingerprint, qualityPolicySha256: hash(plan.qualityPolicy),
    developmentDatasetSha256: plan.request.developmentDatasetSha256, developmentFingerprint: plan.developmentFingerprint,
    warmupFromAt: plan.request.warmupFromAt, testFromAt: plan.testFromAt, evaluateNotBefore: plan.evaluateNotBefore,
    syntheticOnly: plan.syntheticOnly, code });
}

export function verifyRegisteredV1Candidate(candidateInput: unknown, planInput: unknown, catalogue: unknown,
  development: unknown, planSha256: string, currentCode: unknown) {
  if (candidateInput === null || typeof candidateInput !== 'object' || !('registration' in candidateInput))
    throw Error('v1_candidate_invalid');
  const registration = V1CandidateRegistrationSchema.parse(candidateInput.registration);
  const rebuilt = registerV1Candidate(planInput, catalogue, development, planSha256, currentCode, registration.kernelRegisteredAt);
  return verifyV1Candidate(candidateInput, rebuilt.registration);
}
