import { createHash } from 'node:crypto';
import { V1ExecutableFreezeBodySchema, V1ExecutableFreezeSchema, type V1ReleaseInventory } from '@dota/contracts';
import { verifyV1Candidate, type createV1Candidate } from '@dota/prediction';
import { canonicalContextJson } from './temporal.js';
import { type verifyV1ReleasePlan } from './v1-release-plan.js';
const hash = (v: unknown) => createHash('sha256').update(canonicalContextJson(v)).digest('hex');
type Plan = ReturnType<typeof verifyV1ReleasePlan>;
type Candidate = ReturnType<typeof createV1Candidate>;
export function registerV1ExecutableFreeze(plan: Plan, candidate: Candidate, planSha256: string,
  candidateSha256: string, code: V1ReleaseInventory['source']['code'], runtime: unknown, registeredAt: string) {
  verifyV1Candidate(candidate, candidate.registration);
  if (candidate.registration.planFingerprint !== plan.fingerprint || candidate.registration.planSha256 !== planSha256 ||
    candidate.qualityPolicySha256 !== hash(plan.qualityPolicy) || candidate.registration.syntheticOnly !== plan.syntheticOnly)
    throw Error('freeze_candidate_binding');
  if (registeredAt < candidate.registration.kernelRegisteredAt || registeredAt >= plan.testFromAt) throw Error('freeze_registration_window');
  const body = V1ExecutableFreezeBodySchema.parse({ schemaVersion: 1, format: 'v1-release-executable-freeze-v1',
    registeredAt, planSha256, planFingerprint: plan.fingerprint, candidateSha256, candidateFingerprint: candidate.fingerprint,
    qualityPolicySha256: candidate.qualityPolicySha256, testFromAt: plan.testFromAt, evaluateNotBefore: plan.evaluateNotBefore,
    syntheticOnly: plan.syntheticOnly, code: [...code].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    runtime, complete: true, activation: 'separate_gate_required' });
  // The full manifest must contain every kernel dependency at its registered hash.
  if (candidate.registration.code.some(c => !body.code.some(f => f.path === c.path && f.sha256 === c.sha256)))
    throw Error('freeze_kernel_code_missing');
  return { ...body, fingerprint: hash(body) };
}
export function verifyV1ExecutableFreeze(input: unknown, plan: Plan, candidate: Candidate, planSha256: string,
  candidateSha256: string, code: V1ReleaseInventory['source']['code'], runtime: unknown) {
  const parsed = V1ExecutableFreezeSchema.parse(input);
  const rebuilt = registerV1ExecutableFreeze(plan, candidate, planSha256, candidateSha256, code, runtime, parsed.registeredAt);
  if (canonicalContextJson(parsed) !== canonicalContextJson(rebuilt)) throw Error('freeze_replay_mismatch');
  return rebuilt;
}
