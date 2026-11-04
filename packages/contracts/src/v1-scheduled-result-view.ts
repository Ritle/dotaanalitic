import {z} from 'zod';
import {V1ScheduleResultRequestSchema} from './v1-schedule-result.js';
import {V1ForecastOutcomeSchema,V1ScheduledRealTargetSchema} from './v1-forecast.js';
const Id=z.uuid(),Sha=z.string().regex(/^[a-f0-9]{64}$/);
export const V1ScheduledBindingCreateSchema=V1ScheduleResultRequestSchema.omit({predictionRequestId:true,targetSha256:true})
  .extend({sourceUrl:V1ScheduleResultRequestSchema.shape.sourceUrl.max(2048),confirmedByOwner:z.literal(true)}).strict();
export const V1ScheduledOutcomeRefreshSchema=z.object({requestId:Id,expectedRevision:z.number().int().nonnegative().max(2147483646)}).strict();
export const V1ScheduledBindingViewSchema=z.object({requestId:Id,sha256:Sha,target:V1ScheduledRealTargetSchema,
  predictionRequestId:Id,matchId:V1ScheduleResultRequestSchema.shape.matchId,providerSeriesId:V1ScheduleResultRequestSchema.shape.providerSeriesId,
  sourceUrl:V1ScheduleResultRequestSchema.shape.sourceUrl,rationale:V1ScheduleResultRequestSchema.shape.rationale,
  reviewedAt:z.iso.datetime({precision:6}),basis:z.literal('owner_reviewed_cross_provider_mapping')}).strict();
export const V1ScheduledBindingStateSchema=z.object({binding:V1ScheduledBindingViewSchema.nullable()}).strict();
/** Map-number raw observation JSON remains in storage; the verified summary is sufficient for owner review. */
const {mapNumberEvidence:_,...summaryShape}=V1ForecastOutcomeSchema.shape;
export const V1ScheduledOutcomeSummarySchema=z.object(summaryShape)
  .strict().refine(r=>(r.status==='linked')===(r.outcome!==null)&&(!r.prospectiveEligible||r.status==='linked'&&r.reasons.length===0));
export const V1ScheduledOutcomeViewSchema=z.object({revision:z.number().int().positive(),sha256:Sha,previousSha256:Sha.nullable(),result:V1ScheduledOutcomeSummarySchema}).strict();
export const V1ScheduledOutcomeHistorySchema=z.object({items:z.array(V1ScheduledOutcomeViewSchema).max(20),nextBeforeRevision:z.number().int().positive().nullable()}).strict();
export type V1ScheduledBindingCreate=z.infer<typeof V1ScheduledBindingCreateSchema>;
export type V1ScheduledOutcomeRefresh=z.infer<typeof V1ScheduledOutcomeRefreshSchema>;
export type V1ScheduledOutcomeView=z.infer<typeof V1ScheduledOutcomeViewSchema>;
