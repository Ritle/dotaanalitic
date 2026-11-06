import { z } from 'zod';
import { V1CandidateCodeSchema } from './v1-candidate.js';
import { V1FreezeRuntimeSchema } from './v1-executable-freeze.js';

const Sha = z.string().regex(/^[a-f0-9]{64}$/), Time = z.iso.datetime({ precision: 3 });
const File = z.object({ path: z.string().min(1).max(1024), sha256: Sha }).strict();
export const HistoricalExecutionConfigSchema = z.object({
  schemaVersion: z.literal(1), importPlan: File, dataset: File
}).strict();
const Evidence = z.object({ sha256: Sha, text: z.string().min(2).max(67108864) }).strict();
export const HistoricalExecutionCapsuleSchema = z.object({
  schemaVersion: z.literal(1), format: z.literal('v1-historical-execution-input-v1'), preparedAt: Time,
  protocol: Evidence, catalogue: Evidence, exposure: Evidence, importPlan: Evidence, dataset: Evidence,
  coverage: z.unknown(), fingerprint: Sha
}).strict();
export const HistoricalExecutableFreezeBodySchema = z.object({
  schemaVersion: z.literal(1), format: z.literal('v1-historical-executable-freeze-v1'), registeredAt: Time,
  capsuleSha256: Sha, capsuleFingerprint: Sha, protocolSha256: Sha, protocolFingerprint: Sha,
  datasetSha256: Sha, datasetFingerprint: Sha, importPlanSha256: Sha,
  qualityPolicySha256: Sha, candidateFingerprint: Sha, targetLedgerFingerprint: Sha,
  code: V1CandidateCodeSchema, runtime: V1FreezeRuntimeSchema, syntheticOnly: z.boolean(),
  evaluator: z.literal('v1-historical-evaluation-v1'), registry: z.literal('v1-historical-registry-binding-v1'),
  evaluationBasis: z.literal('conditional_retrospective_unexposed_series'),
  complete: z.literal(true), activation: z.literal('separate_gate_required')
}).strict();
export const HistoricalExecutableFreezeSchema = HistoricalExecutableFreezeBodySchema.extend({ fingerprint: Sha });
export const HistoricalEvaluationStartSchema = z.object({
  schemaVersion: z.literal(1), format: z.literal('v1-historical-first-scoring-v1'),
  startedAt: Time, freezeSha256: Sha, freezeFingerprint: Sha, capsuleSha256: Sha
}).strict();
