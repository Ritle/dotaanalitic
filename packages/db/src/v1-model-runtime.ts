import type { ScenarioSnapshot, V1FeatureHistory } from '@dota/contracts';
import { buildV1Features, eloLink } from '@dota/prediction';
import { sql, type Db, type Database, type Transaction } from './index.js';
import { V1ModelRegistry } from './v1-registry-repository.js';
import { RetestActivationRegistry } from './v1-retest-activation-repository.js';
import { compatibleV1Runtime, type readV1RuntimeCode } from './v1-runtime-code.js';
import { computeV1RuntimeFeatures, runtimeFeatureScenario, runtimeUs } from './v1-runtime.js';

/** Version dispatch is server-side and cannot be selected through an HTTP request. */
export class PredictionModelRegistry {
  constructor(private readonly db: Db) {}
  async lockForPrediction(tx: Transaction<Database>) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('model-registry:pre_match',0))`.execute(tx);
    const active = (await sql<{ id: string }>`SELECT m.id FROM prediction_model_versions m JOIN v1_retest_model_artifacts a ON a.model_id=m.id
      WHERE m.stage='pre_match' AND m.is_active`.execute(tx)).rows[0];
    if (active) return new RetestActivationRegistry(this.db).lockForPrediction(tx, active.id);
    const gate = await new V1ModelRegistry(this.db).lockForPrediction(tx);
    return gate.status === 'model_eligible' ? { ...gate, kind: 'legacy' as const } : gate;
  }
  async readiness() {
    return this.db.transaction().execute(async tx => {
      const gate = await this.lockForPrediction(tx);
      return gate.status === 'unavailable' ? { status: gate.status, reason: gate.reason, modelId: gate.modelId, teamAWinProbability: null }
        : { status: gate.status, modelId: gate.modelId, reportSha256: gate.reportSha256, teamAWinProbability: null };
    });
  }
}
type Gate = Awaited<ReturnType<PredictionModelRegistry['lockForPrediction']>>;
export const runtimeModelWarmup = (gate: Gate) => gate.status === 'unavailable' ? '2024-01-01T00:00:00.000Z'
  : gate.kind === 'retest' ? gate.metadata.warmupFromAt : gate.artifact.plan.request.warmupFromAt;
export const runtimeModelCompatible = (gate: Gate, code: Awaited<ReturnType<typeof readV1RuntimeCode>>) =>
  gate.status === 'model_eligible' && (gate.kind === 'retest' || compatibleV1Runtime(gate.artifact.freeze, code));
export function computeRuntimeModelFeatures(history: V1FeatureHistory, scenario: ScenarioSnapshot, cutoffAt: string, gate: Gate | null) {
  if (!gate || gate.status === 'unavailable' || gate.kind === 'legacy')
    return computeV1RuntimeFeatures(history, scenario, cutoffAt, gate?.status === 'model_eligible' && gate.kind === 'legacy' ? gate.artifact : null);
  if (history.syntheticOnly) throw Error('runtime_synthetic_forbidden');
  const input = runtimeFeatureScenario(history, scenario, cutoffAt);
  if (!input) return { features: null, probability: null, reasons: ['CURRENT_IDENTITIES_UNVERIFIED'] };
  const features = buildV1Features(history, input);
  if (features.history.warmupFromAtUs !== runtimeUs(gate.metadata.warmupFromAt)) throw Error('retest_runtime_history_window');
  return { features, probability: features.features === null ? null : eloLink(features.features.eloDifference), reasons: features.reasons };
}
export function runtimeModelSnapshot(gate: Gate) {
  if (gate.status === 'unavailable') return gate;
  if (gate.kind === 'retest') return { status: gate.status, registryFormat: 'v1-retest-registry-v1', modelId: gate.modelId,
    activationEventId: gate.activationEventId, protocolFingerprint: gate.metadata.protocolFingerprint,
    evaluationBasis: gate.metadata.evaluationBasis, reportSha256: gate.reportSha256, freezeSha256: gate.freezeSha256,
    candidateFingerprint: gate.metadata.candidateFingerprint, runtimeSha256: gate.runtimeSha256 };
  return { status: gate.status, modelId: gate.modelId, activationEventId: gate.activationEventId,
    planFingerprint: gate.artifact.plan.fingerprint, releaseRevision: gate.releaseRevision, reportSha256: gate.reportSha256,
    candidateSha256: gate.artifact.bytes.candidateSha256, freezeSha256: gate.artifact.bytes.freezeSha256 };
}
