import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
import {V1ForecastOutcomeSchema,V1ScheduledRealTargetSchema} from './v1-forecast.js';
export const V1ScheduleResultRequestSchema=z.object({requestId:z.uuid().transform(v=>v.toLowerCase()),
  predictionRequestId:z.uuid().transform(v=>v.toLowerCase()),targetSha256:z.string().regex(/^[a-f0-9]{64}$/),
  matchId:CatalogIdSchema,providerSeriesId:CatalogIdSchema,
  sourceUrl:z.url().refine(v=>new URL(v).protocol==='https:'),rationale:z.string().trim().min(20).max(2000)}).strict();
export const V1ScheduleResultRecordSchema=z.object({format:z.literal('v1-schedule-result-binding-v1'),ownerId:z.uuid(),
  request:V1ScheduleResultRequestSchema,predictionId:z.uuid(),target:V1ScheduledRealTargetSchema,
  reviewedAt:z.iso.datetime({precision:6}),basis:z.literal('owner_reviewed_cross_provider_mapping'),
  verification:V1ForecastOutcomeSchema}).strict();
