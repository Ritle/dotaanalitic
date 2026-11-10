// Explicit synthetic repository-boundary double, only for disposable PostgreSQL tests.
// It lacks a valid source capsule and is rejected by the production replay verifier.
import { createHash, randomBytes } from 'node:crypto';
import type { RetestRegistryEvidence, RetestRegistryMetadata } from '@dota/contracts';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const bytes = (value: unknown) => { const text = JSON.stringify(value); return { text, sha256: sha(text) }; };
export function retestRegistryFixture() {
  const fingerprint = sha(randomBytes(16).toString('hex')), at = '2020-01-01T00:00:00.000Z';
  const capsule = bytes({ format: 'v1-retest-execution-input-v2', fixture: 'SYNTHETIC_REPOSITORY_DOUBLE' });
  const freeze = bytes({ format: 'v1-retest-executable-freeze-v2', syntheticOnly: false, fingerprint, capsuleSha256: capsule.sha256 });
  const start = { format: 'v1-retest-first-scoring-v2', startedAt: at }, started = bytes(start);
  const report = bytes({ format: 'v1-retest-evaluation-v2', syntheticOnly: false, qualityDecision: 'passed', releaseGatePassed: true,
    fingerprint, freezeSha256: freeze.sha256, firstScoring: start });
  const binding = bytes({ format: 'v1-retest-registry-binding-v2', eligibleForActivation: true, evaluationFingerprint: fingerprint });
  const evidence: RetestRegistryEvidence = { schemaVersion: 1, format: 'v1-retest-registry-evidence-v1', capsule, freeze, started, report, binding };
  const metadata: RetestRegistryMetadata = { schemaVersion: 1, stage: 'pre_match', algorithm: 'fixed_player_mean_elo',
    featureSchemaVersion: 'player-mean-elo-completed-strict-v1', evaluationBasis: 'conditional_retrospective_unexposed_series', qualityDecision: 'passed',
    protocolFingerprint: fingerprint, datasetFingerprint: fingerprint, candidateFingerprint: fingerprint, freezeFingerprint: fingerprint,
    reportFingerprint: fingerprint, qualityPolicySha256: fingerprint, previousReportSha256: fingerprint, scorerCodeFingerprint: fingerprint,
    registeredAt: at, firstScoringAt: at, warmupFromAt: '2018-01-01T00:00:00.000Z', testFromAt: '2019-01-01T00:00:00.000Z', testUntil: '2019-02-01T00:00:00.000Z',
    scoredMaps: 100, scoredSeries: 50, metrics: { n: 100, brier: .2, logLoss: .6, ece: .01 },
    runtime: { node: 'synthetic', platform: 'synthetic', arch: 'synthetic', nodeBinarySha256: fingerprint },
    syntheticOnly: false, isActive: false, deployable: false };
  return { evidence, metadata };
}
