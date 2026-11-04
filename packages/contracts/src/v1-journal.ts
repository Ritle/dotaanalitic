import { z } from 'zod';
import { CatalogIdSchema } from './catalog.js';
import { V1ForecastOutcomeSchema, V1AnyRealTargetSchema } from './v1-forecast.js';
const Id=z.uuid().transform(v=>v.toLowerCase()),Sha=z.string().regex(/^[a-f0-9]{64}$/),Time=z.iso.datetime({precision:3}),Clock=z.iso.datetime({precision:6});
export const V1JournalStatusSchema=z.enum(['what_if','unavailable','pending_verification','unlinked','excluded','primary','superseded']);
export const V1JournalFiltersSchema=z.object({fromAt:Time.nullable().default(null),until:Time.nullable().default(null),
  modelId:Id.nullable().default(null),status:V1JournalStatusSchema.nullable().default(null)}).strict()
  .refine(v=>!v.fromAt||!v.until||v.fromAt<v.until);
export const V1JournalRequestSchema=z.object({requestId:Id,filters:V1JournalFiltersSchema}).strict();
export const V1JournalObservationSchema=z.object({id:Id,requestId:Id,snapshotSha256:Sha,purpose:z.enum(['what_if_single_map','real_map']),
  status:z.enum(['done','unavailable']),modelId:Id.nullable(),eligibleModelAtIssuance:z.boolean(),probability:z.number().min(0).max(1).nullable(),
  createdAt:Clock,issuedAt:Clock.nullable(),cutoffAt:Time,scenarioId:Id,scenarioRevision:z.number().int().positive(),
  title:z.string(),teamAId:CatalogIdSchema,teamBId:CatalogIdSchema,scheduledAt:Time.nullable(),
  lineupA:z.array(CatalogIdSchema).length(5),lineupB:z.array(CatalogIdSchema).length(5),
  target:V1AnyRealTargetSchema.nullable(),attemptReasons:z.array(z.string()),
  latestOutcome:z.object({revision:z.number().int().positive(),sha256:Sha,contentSha256:Sha}).strict().nullable(),
  binding:z.object({sourcePredictionId:Id,revision:z.number().int().positive(),sha256:Sha,matchId:CatalogIdSchema}).strict().nullable(),
  bindingConflict:z.boolean(),verification:V1ForecastOutcomeSchema.nullable(),sourceChangedSinceRefresh:z.boolean().nullable()
}).strict().refine(r=>r.purpose==='real_map'?r.target!==null:r.target===null);
export const V1JournalInputSchema=z.object({format:z.literal('v1-journal-input-v1'),capturedAt:Clock,code:z.json(),
  observations:z.array(V1JournalObservationSchema).max(5000)}).strict();
export type V1JournalObservation=z.infer<typeof V1JournalObservationSchema>;
export type V1JournalFilters=z.infer<typeof V1JournalFiltersSchema>;
export type V1JournalInput=z.infer<typeof V1JournalInputSchema>;
const Count=z.number().int().nonnegative(),Rate=z.number().min(0).max(1).nullable();
export const V1JournalMetricsSchema=z.object({n:Count,accuracyN:Count,correct:Count,ties:Count,accuracy:Rate,brier:Rate,
  logLoss:z.number().nonnegative().nullable(),reliability:z.array(z.object({lower:z.number(),upper:z.number(),upperInclusive:z.boolean(),
    n:Count,meanProbability:Rate,observedWinRate:Rate}).strict()).length(10)}).strict();
export const V1JournalSummarySchema=z.object({primaryPolicy:z.literal('last_successful_pre_start_v1'),metricPolicy:z.literal('forecast-binary-v1'),
  periodField:z.literal('forecast_created_at'),logLossClip:z.literal(1e-15),filters:V1JournalFiltersSchema,
  inventoryCount:Count,globalPrimaryMaps:Count,counts:z.object({attempts:Count,realAttempts:Count,whatIfAttempts:Count,issued:Count,
    unavailable:Count,pendingVerification:Count,unlinked:Count,excluded:Count,superseded:Count,primaryMaps:Count,
    verifiedMaps:Count,cancelled:z.null()}).strict(),metrics:V1JournalMetricsSchema,matchedLineupMetrics:V1JournalMetricsSchema,
  rows:z.array(z.object({predictionId:Id,status:V1JournalStatusSchema,reasons:z.array(z.string()),matchId:CatalogIdSchema.nullable(),
    primaryPredictionId:Id.nullable(),favourite:z.enum(['A','B']).nullable(),correct:z.boolean().nullable()}).strict()).max(5000),
  warnings:z.array(z.string())}).strict();
export const V1ForecastJournalReportSchema=z.object({format:z.literal('v1-journal-report-v1'),ownerId:Id,request:V1JournalRequestSchema,
  revision:z.number().int().positive(),previousSha256:Sha.nullable(),inputSha256:Sha,capturedAt:Clock,summary:V1JournalSummarySchema}).strict();
