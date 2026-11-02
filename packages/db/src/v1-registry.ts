import { createHash } from 'node:crypto';
import { V1RegistryArtifactSchema, V1RegistryPlanSchema, V1CandidateRegistrationSchema,
  V1ExecutableFreezeSchema, JournalledV1ReleaseReportSchema } from '@dota/contracts';
import { verifyV1Candidate, V1_RELEASE_QUALITY_POLICY } from '@dota/prediction';
import { canonicalContextJson } from './temporal.js';
export const registrySha = (text: string) => createHash('sha256').update(text).digest('hex');
export const registryHash = (value: unknown) => registrySha(canonicalContextJson(value));
function checkedHash(value: { fingerprint: string }) {
  const { fingerprint, ...body } = value;
  if (registryHash(body) !== fingerprint) throw Error('registry_artifact_hash');
}
/** Durable bytes; CLI additionally verifies the pinned bundle and original plan sources. */
export function verifyV1RegistryArtifact(input: unknown) {
  const bytes = V1RegistryArtifactSchema.parse(input);
  for (const [text, digest] of [[bytes.planText, bytes.planSha256], [bytes.candidateText, bytes.candidateSha256], [bytes.freezeText, bytes.freezeSha256]])
    if (Buffer.byteLength(text!) > 4194304 || registrySha(text!) !== digest) throw Error('registry_artifact_hash');
  const plan = V1RegistryPlanSchema.parse(JSON.parse(bytes.planText)); checkedHash(plan);
  const raw: unknown = JSON.parse(bytes.candidateText);
  if (!raw || typeof raw !== 'object' || !('registration' in raw)) throw Error('registry_candidate_invalid');
  const registration = V1CandidateRegistrationSchema.parse(raw.registration), candidate = verifyV1Candidate(raw, registration);
  const freeze = V1ExecutableFreezeSchema.parse(JSON.parse(bytes.freezeText)); checkedHash(freeze);
  if (plan.syntheticOnly || registration.syntheticOnly || freeze.syntheticOnly) throw Error('registry_synthetic_forbidden');
  if (registryHash(plan.qualityPolicy) !== registryHash(V1_RELEASE_QUALITY_POLICY) ||
    registration.planSha256 !== bytes.planSha256 || registration.planFingerprint !== plan.fingerprint ||
    registration.planRegisteredAt !== plan.registeredAt || registration.developmentFingerprint !== plan.developmentFingerprint ||
    registration.developmentDatasetSha256 !== plan.request.developmentDatasetSha256 || registration.warmupFromAt !== plan.request.warmupFromAt ||
    registration.testFromAt !== plan.testFromAt || registration.evaluateNotBefore !== plan.evaluateNotBefore ||
    freeze.planSha256 !== bytes.planSha256 || freeze.planFingerprint !== plan.fingerprint ||
    freeze.candidateSha256 !== bytes.candidateSha256 || freeze.candidateFingerprint !== candidate.fingerprint ||
    freeze.qualityPolicySha256 !== candidate.qualityPolicySha256 || freeze.testFromAt !== plan.testFromAt ||
    freeze.evaluateNotBefore !== plan.evaluateNotBefore || freeze.registeredAt < registration.kernelRegisteredAt ||
    freeze.registeredAt >= plan.testFromAt ||
    registration.code.some(c => !freeze.code.some(f => f.path === c.path && f.sha256 === c.sha256))) throw Error('registry_artifact_binding');
  return { bytes, plan, candidate, freeze };
}
export function verifyV1RegistryRelease(artifact: ReturnType<typeof verifyV1RegistryArtifact>, input: unknown, now: string) {
  const journal = JournalledV1ReleaseReportSchema.parse(input); checkedHash(journal); checkedHash(journal.report);
  const r = journal.report;
  if (r.format !== 'v1-release-evaluation-v2' || !r.releaseGatePassed || r.evaluation.syntheticOnly ||
    r.evaluation.status !== 'evaluation_complete' || r.evaluation.qualityDecision !== 'passed') throw Error('registry_quality_not_passed');
  if (journal.journal.planSha256 !== artifact.bytes.planSha256 || journal.journal.planFingerprint !== artifact.plan.fingerprint ||
    r.planFingerprint !== artifact.plan.fingerprint || r.candidateFingerprint !== artifact.candidate.fingerprint ||
    r.freezeFingerprint !== artifact.freeze.fingerprint || r.freezeSha256 !== artifact.bytes.freezeSha256 ||
    registryHash(r.scorerCode) !== registryHash(artifact.freeze.code)) throw Error('registry_release_binding');
  if (now < artifact.plan.evaluateNotBefore || journal.journal.recordedAt < artifact.plan.evaluateNotBefore ||
    journal.journal.recordedAt > now) throw Error('registry_time_gate');
  return journal;
}
