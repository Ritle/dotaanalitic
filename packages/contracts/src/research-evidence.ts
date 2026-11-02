import { z } from 'zod';
import { ResearchExecutionSchema } from './research-execution.js';
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
export const ResearchEvidenceExclusionsSchema = z.array(z.object({ matchId: z.string().regex(/^[1-9]\d{0,18}$/),
  reasons: z.array(z.string().regex(/^EVIDENCE_[A-Z_]+$/)).min(1).max(30) }).strict()).max(5000);
export const ResearchEvidenceFilesSchema = z.object({
  configPath: z.string().min(1).max(1024), configSha256: Sha,
  unionPath: z.string().min(1).max(1024), unionSha256: Sha,
  batches: z.array(z.object({ directory: z.string().min(1).max(1024), manifestSha256: Sha }).strict()).max(100)
}).strict();
export const ResearchEvidenceExecutionBodySchema = z.object({
  schemaVersion: z.literal(1), format: z.literal('research-evidence-execution-v1'),
  execution: ResearchExecutionSchema, evidence: ResearchEvidenceFilesSchema,
  evidenceFingerprint: Sha, trainingReady: z.literal(false), deployable: z.literal(false)
}).strict();
export const ResearchEvidenceExecutionSchema = ResearchEvidenceExecutionBodySchema.extend({ fingerprint: Sha });
