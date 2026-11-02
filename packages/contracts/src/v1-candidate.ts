import { z } from 'zod';
import { CanonicalPlayerIdSchema } from './identity.js';
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Time = z.iso.datetime({ precision: 3 });
const Us = z.string().regex(/^(0|[1-9]\d{0,17})$/);
export const V1CandidateCodeSchema = z.array(z.object({
  path: z.string().regex(/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/).max(512)
    .refine(p => !p.split('/').some(part => part === '.' || part === '..')),
  sha256: Sha
}).strict()).min(1).max(2000).refine(rows => new Set(rows.map(r => r.path)).size === rows.length,
  { message: 'duplicate_candidate_code_path' });
export const V1CandidateRegistrationSchema = z.object({
  kernelRegisteredAt: Time, planRegisteredAt: Time, planSha256: Sha, planFingerprint: Sha,
  qualityPolicySha256: Sha, developmentDatasetSha256: Sha, developmentFingerprint: Sha,
  warmupFromAt: Time, testFromAt: Time, evaluateNotBefore: Time, syntheticOnly: z.boolean(),
  code: V1CandidateCodeSchema
}).strict().refine(r => r.planRegisteredAt <= r.kernelRegisteredAt && r.kernelRegisteredAt < r.testFromAt &&
  r.warmupFromAt < r.testFromAt && r.testFromAt < r.evaluateNotBefore,
{ message: 'invalid_candidate_registration_window' });
export type V1CandidateRegistration = z.infer<typeof V1CandidateRegistrationSchema>;

const SeriesKey = z.string().regex(/^[a-z][a-z0-9_-]{0,30}:[1-9]\d{0,18}$/);
export const V1MetricInputSchema = z.object({
  schemaVersion: z.literal(1), purpose: z.literal('unbound_metric_diagnostic'), syntheticOnly: z.boolean(),
  ledger: z.array(z.object({ matchId: CanonicalPlayerIdSchema, seriesKey: SeriesKey.nullable(),
    disposition: z.enum(['scored', 'excluded']), reasons: z.array(z.string().min(1).max(128)).max(30)
  }).strict()).max(5000),
  rows: z.array(z.object({ matchId: CanonicalPlayerIdSchema, seriesKey: SeriesKey,
    startedAtUs: Us, probability: z.number().min(0).max(1), teamAWon: z.boolean()
  }).strict()).max(5000)
}).strict();
export type V1MetricInput = z.infer<typeof V1MetricInputSchema>;
