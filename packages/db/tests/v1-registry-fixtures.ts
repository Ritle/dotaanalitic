import { randomUUID } from 'node:crypto';
import { reseal } from '../../ingestion/tests/v1-release-evidence-fixtures.js';
import { releaseJournalFixture } from '../../ingestion/tests/v1-release-evaluation-fixtures.js';
import { createV1Candidate } from '../../prediction/src/v1-candidate.js';
import { registerV1ExecutableFreeze } from '../src/v1-executable-freeze.js';
import { registrySha, registryHash, verifyV1RegistryArtifact } from '../src/v1-registry.js';
// Synthetic CONTRACT DOUBLE of a committed passing report. No maps/labels are evaluated,
// reclassified, imported or published. Only disposable DBs receive these protocol assertions.
export function registryFixture(tag = randomUUID()) {
  const f = releaseJournalFixture('registry-' + tag);
  const plan = reseal({ ...f.plan, syntheticOnly: false });
  const planText = JSON.stringify(plan), planSha256 = registrySha(planText);
  const candidate = createV1Candidate({ ...f.candidate.registration, planSha256, planFingerprint: plan.fingerprint, syntheticOnly: false });
  const candidateText = JSON.stringify(candidate), candidateSha256 = registrySha(candidateText);
  const freeze = registerV1ExecutableFreeze(plan, candidate, planSha256, candidateSha256, f.code,
    { node: 'v22.15.0', platform: 'win32', arch: 'x64', nodeBinarySha256: 'b'.repeat(64) }, candidate.registration.kernelRegisteredAt);
  const freezeText = JSON.stringify(freeze), freezeSha256 = registrySha(freezeText);
  const bytes = { planText, planSha256, candidateText, candidateSha256, freezeText, freezeSha256 };
  const artifact = verifyV1RegistryArtifact(bytes);
  const captureText = JSON.stringify({ format: 'v1-release-source-capture-v1', executableFreeze: freeze,
    inventory: { source: { syntheticOnly: false } }, contractDouble: true });
  const report = { schemaVersion: 1 as const, format: 'v1-release-evaluation-v2' as const,
    executionFingerprint: registryHash('contract-capture'), planFingerprint: plan.fingerprint, candidateFingerprint: candidate.fingerprint,
    bindingFingerprint: registryHash('contract-binding'), scorerCode: f.code,
    evaluation: { status: 'evaluation_complete' as const, qualityDecision: 'passed' as const, syntheticOnly: false },
    executableFreezeComplete: true as const, freezeFingerprint: freeze.fingerprint, freezeSha256,
    releaseGatePassed: true, deployable: false as const, teamAWinProbability: null, publicationBlockers: ['MODEL_NOT_ACTIVE'],
    contractDouble: true };
  const identity = { planSha256, planFingerprint: plan.fingerprint, revision: 1, parentRevision: null, parentReportSha256: null,
    reason: null, captureSha256: registrySha(captureText), scorerSha256: registryHash(f.code), recordedAt: plan.evaluateNotBefore };
  const sealedReport = { ...report, fingerprint: registryHash(report) };
  const body = { schemaVersion: 1 as const, format: 'journalled-v1-release-report-v1' as const, journal: identity, report: sealedReport };
  const journal = { ...body, fingerprint: registryHash(body) };
  return { bytes, artifact, plan, candidate, freeze, captureText, journal,
    request: { requestId: randomUUID(), action: 'promote' as const, modelId: randomUUID(), expectedCurrentId: null,
      reason: 'Synthetic registry protocol test', release: { planFingerprint: plan.fingerprint, revision: 1,
        reportSha256: registrySha(JSON.stringify(journal)) } } };
}
