import {z} from 'zod';
import {HistoricalExecutionConfigSchema, HistoricalExecutableFreezeBodySchema,
  HistoricalEvaluationStartSchema} from './v1-historical-execution.js';

const Sha=z.string().regex(/^[a-f0-9]{64}$/);
const Evidence=z.object({sha256:Sha,text:z.string().min(2).max(134217728)}).strict();
export const RetestExecutionConfigSchema=HistoricalExecutionConfigSchema.extend({schemaVersion:z.literal(2)}).strict();
export const RetestExecutionCapsuleSchema=z.object({
  schemaVersion:z.literal(2),format:z.literal('v1-retest-execution-input-v2'),preparedAt:z.iso.datetime({precision:3}),
  protocol:Evidence,protocolInputs:Evidence,protocolSources:z.array(Evidence).min(1).max(40),
  closure:Evidence,sourceManifest:Evidence,importPlan:Evidence,dataset:Evidence,coverage:z.unknown(),fingerprint:Sha
}).strict();
export const RetestExecutableFreezeBodySchema=HistoricalExecutableFreezeBodySchema.extend({
  schemaVersion:z.literal(2),format:z.literal('v1-retest-executable-freeze-v2'),
  closureSha256:Sha,sourceManifestSha256:Sha,previousReportSha256:Sha,
  evaluator:z.literal('v1-retest-evaluation-v2'),registry:z.literal('v1-retest-registry-binding-v2')
}).strict();
export const RetestExecutableFreezeSchema=RetestExecutableFreezeBodySchema.extend({fingerprint:Sha});
export const RetestEvaluationStartSchema=HistoricalEvaluationStartSchema.extend({
  schemaVersion:z.literal(2),format:z.literal('v1-retest-first-scoring-v2')
}).strict();
