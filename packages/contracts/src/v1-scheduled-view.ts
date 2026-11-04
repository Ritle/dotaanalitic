import {z} from 'zod';
import {V1PredictionViewSchema} from './v1-prediction-view.js';
import {V1RuntimeRequestSchema} from './v1-runtime.js';
import {V1ScheduledRealTargetSchema} from './v1-forecast.js';
export const V1ScheduledPredictionCreateSchema=z.object({requestId:z.uuid(),scenarioId:z.uuid(),
  expectedRevision:z.number().int().positive().max(2147483646),targetSha256:z.string().regex(/^[a-f0-9]{64}$/),
  targetScope:V1RuntimeRequestSchema.shape.targetScope}).strict();
export const V1ScheduledPredictionViewSchema=z.object({...V1PredictionViewSchema.shape,purpose:z.literal('real_map'),target:V1ScheduledRealTargetSchema})
  .strict().refine(s=>s.status==='done'?s.teamAWinProbability!==null&&s.issuedAt!==null&&s.reasons.length===0&&s.model.eligibleAtCalculation:
    s.teamAWinProbability===null&&s.issuedAt===null&&s.reasons.length>0);
export type V1ScheduledPredictionCreate=z.infer<typeof V1ScheduledPredictionCreateSchema>;
export type V1ScheduledPredictionView=z.infer<typeof V1ScheduledPredictionViewSchema>;
