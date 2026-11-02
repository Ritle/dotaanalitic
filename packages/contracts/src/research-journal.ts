import { z } from 'zod';
import { ResearchExecutionCodeSchema } from './research-execution.js';
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
export const ResearchJournalRevisionSchema = z.object({
  parentRevision: z.number().int().min(1).max(2147483646), parentReportSha256: Sha,
  reason: z.string().trim().min(10).max(1000)
}).strict();
export const ResearchJournalRequestSchema = z.object({
  planSha256: Sha, planFingerprint: Sha, captureSha256: Sha, captureText: z.string().min(1).max(67108864),
  scorerCode: ResearchExecutionCodeSchema, revision: ResearchJournalRevisionSchema.nullable().default(null)
}).strict();
export const ResearchJournalIdentitySchema = z.object({
  planSha256: Sha, planFingerprint: Sha, revision: z.number().int().min(1).max(2147483647),
  parentRevision: z.number().int().positive().nullable(), parentReportSha256: Sha.nullable(), reason: z.string().nullable(),
  captureSha256: Sha, scorerSha256: Sha, recordedAt: z.iso.datetime({ precision: 3 })
}).strict();
// The full evaluator owns its report fields. This boundary additionally checks provenance and non-release status.
export const JournalEvaluationReportSchema = z.object({
  schemaVersion: z.literal(1), format: z.literal('research-evidence-report-v1'),
  executionFingerprint: Sha, planFingerprint: Sha, fingerprint: Sha, scorerCode: ResearchExecutionCodeSchema,
  evaluation: z.object({ status: z.enum(['research_complete', 'unavailable']) }).passthrough(),
  releaseGate: z.literal('not_assessed'), trainingReady: z.literal(false), deployable: z.literal(false), teamAWinProbability: z.null()
}).passthrough();
export const JournalledResearchReportSchema = z.object({
  schemaVersion: z.literal(1), format: z.literal('journalled-research-report-v1'),
  journal: ResearchJournalIdentitySchema, report: JournalEvaluationReportSchema, fingerprint: Sha
}).strict();
