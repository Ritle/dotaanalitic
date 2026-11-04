import { z } from 'zod';
import { ScenarioSnapshotSchema } from './scenario.js';
import { V1AnyRealTargetSchema } from './v1-forecast.js';
const Time = z.iso.datetime({ precision: 3 });
const Id = z.string().regex(/^[1-9]\d{0,18}$/).refine(v => BigInt(v) <= 9223372036854775807n);
/** Owner-reviewed scope is frozen per request, never inferred from a provider's professional flag. */
export const V1RuntimeRequestSchema = z.object({
  requestId: z.uuid(), scenarioId: z.uuid(), expectedRevision: z.number().int().min(1).max(2147483647),
  purpose: z.literal('what_if_single_map'),
  targetScope: z.object({ provider: z.literal('opendota'), leagueId: Id,
    eventName: z.string().trim().min(1).max(512), fromAt: Time, until: Time,
    tier: z.literal(1), stage: z.literal('main_event'),
    sourceUrl: z.url().refine(v => new URL(v).protocol === 'https:'),
    rationale: z.string().trim().min(20).max(2000)
  }).strict().refine(s => s.fromAt < s.until).nullable()
}).strict();
export type V1RuntimeRequest = z.infer<typeof V1RuntimeRequestSchema>;
export const V1ForecastRequestSchema = V1RuntimeRequestSchema.extend({ purpose: z.literal('real_map'), realTarget: V1AnyRealTargetSchema });
export const V1AnyRuntimeRequestSchema = z.union([V1RuntimeRequestSchema, V1ForecastRequestSchema]);
export type V1ForecastRequest = z.infer<typeof V1ForecastRequestSchema>;
export const V1RuntimeSnapshotSchema = z.object({ format: z.literal('v1-runtime-snapshot-v1'), request: V1AnyRuntimeRequestSchema,
  scenario: ScenarioSnapshotSchema, createdAt: z.iso.datetime({ precision: 6 }),
  issuedAt: z.iso.datetime({ precision: 6 }).nullable(), cutoffAt: Time,
  status: z.enum(['done', 'unavailable']), teamAWinProbability: z.number().min(0).max(1).nullable(),
  reasons: z.array(z.string()), gate: z.json(), code: z.json(), source: z.json(), features: z.json(),
  warnings: z.array(z.string()), targetReview: z.json()
}).strict().refine(s => s.status === 'done' ? s.teamAWinProbability !== null && s.issuedAt !== null && s.reasons.length === 0 :
  s.teamAWinProbability === null && s.issuedAt === null && s.reasons.length > 0);
