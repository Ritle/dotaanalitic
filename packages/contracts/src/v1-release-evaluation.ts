import { z } from 'zod';
import { V1CandidateCodeSchema } from './v1-candidate.js';
import { ResearchJournalRequestSchema, ResearchJournalIdentitySchema } from './research-journal.js';
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
export const V1ReleaseJournalRequestSchema = ResearchJournalRequestSchema.extend({ scorerCode: V1CandidateCodeSchema });
// The source-bound evaluator owns metric fields; persistence checks provenance and publication boundaries.
export const V1ReleaseReportSchema = z.object({
  schemaVersion: z.literal(1), format: z.literal('v1-release-evaluation-v1'),
  executionFingerprint: Sha, planFingerprint: Sha, candidateFingerprint: Sha, bindingFingerprint: Sha,
  fingerprint: Sha, scorerCode: V1CandidateCodeSchema,
  evaluation: z.object({ status: z.enum(['evaluation_complete', 'unavailable']),
    qualityDecision: z.enum(['passed', 'failed', 'insufficient_evidence', 'unavailable']), syntheticOnly: z.boolean()
  }).passthrough(),
  executableFreezeComplete: z.literal(false), releaseGatePassed: z.literal(false),
  deployable: z.literal(false), teamAWinProbability: z.null()
}).passthrough();
export const V1FrozenReleaseReportSchema = V1ReleaseReportSchema.extend({
  format: z.literal('v1-release-evaluation-v2'), executableFreezeComplete: z.literal(true),
  freezeFingerprint: Sha, freezeSha256: Sha, releaseGatePassed: z.boolean(),
  publicationBlockers: z.array(z.string()),
}).superRefine((r, ctx) => {
  const passed = r.evaluation.status === 'evaluation_complete' && r.evaluation.qualityDecision === 'passed' && !r.evaluation.syntheticOnly;
  if (r.releaseGatePassed !== passed) ctx.addIssue({ code: 'custom', message: 'release_gate_inconsistent' });
});
export const V1JournalReportSchema = z.union([V1ReleaseReportSchema, V1FrozenReleaseReportSchema]);
export const JournalledV1ReleaseReportSchema = z.object({
  schemaVersion: z.literal(1), format: z.literal('journalled-v1-release-report-v1'),
  journal: ResearchJournalIdentitySchema, report: V1JournalReportSchema, fingerprint: Sha
}).strict();
