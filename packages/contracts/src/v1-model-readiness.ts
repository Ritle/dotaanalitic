import { z } from 'zod';
const Common = z.object({ stage: z.literal('pre_match'), checkedAt: z.iso.datetime({ precision: 3 }), teamAWinProbability: z.null() });
/** Registry eligibility only; never a forecast or a scenario coverage guarantee. */
export const V1ModelReadinessSchema = z.discriminatedUnion('status', [
  Common.extend({ status: z.literal('model_eligible'), reason: z.null(), modelId: z.uuid(), reportSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  Common.extend({ status: z.literal('unavailable'), reason: z.enum(['NO_ACTIVE_MODEL', 'ACTIVE_MODEL_EVIDENCE_INVALID']),
    modelId: z.uuid().nullable(), reportSha256: z.null() }).strict().refine(r => r.reason === 'NO_ACTIVE_MODEL' ? r.modelId === null : r.modelId !== null),
]);
export type V1ModelReadiness = z.infer<typeof V1ModelReadinessSchema>;
