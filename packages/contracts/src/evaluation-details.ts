import { z } from 'zod';
const Sha = z.string().regex(/^[a-f0-9]{64}$/), Time = z.iso.datetime({ precision: 3 });
const Id = z.string().regex(/^[1-9]\d{0,18}$/).refine(v => /^[1-9]\d{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n);
export const EvaluationObservationSchema = z.object({ rawBody: z.string().max(8388608),
  source: z.object({ provider: z.literal('opendota'), adapterVersion: z.string().min(1).max(120),
    endpoint: z.string().regex(/^\/heroes$|^\/leagues$|^\/matches\/[1-9]\d*$/), fetchedAt: Time, knownAt: z.null(), payloadSha256: Sha,
    attempts: z.number().int().min(1).max(3), rateLimitRemaining: z.object({
      minute: z.number().nonnegative().nullable(), day: z.number().nonnegative().nullable(), month: z.number().nonnegative().nullable()
    }).strict() }).strict()
}).strict();
export const EvaluationDetailEntrySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('captured'), endpoint: z.string(), matchId: Id.nullable(), observation: EvaluationObservationSchema }).strict(),
  z.object({ status: z.literal('failed'), endpoint: z.string(), matchId: Id.nullable(), failedAt: Time,
    code: z.string().regex(/^[a-z_]{1,80}$/) }).strict()
]);
export type EvaluationDetailEntry = z.infer<typeof EvaluationDetailEntrySchema>;
