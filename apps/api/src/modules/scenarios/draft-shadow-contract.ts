import {z} from 'zod';
import {CaptureTimeSchema} from './draft-capture-contract.js';
const Sha=z.string().regex(/^[a-f0-9]{64}$/);
export const ShadowInputsSchema=z.object({eloLogit:z.number().finite(),observedHeroPracticeLog90Delta:z.number().finite()}).strict();
const Score=z.object({rawProbability:z.number().min(0).max(1),calibratedProbability:z.number().min(0).max(1)}).strict();
export const ShadowScoresSchema=z.object({H0:Score,H1:Score,H2:Score}).strict();
const Ref=z.object({id:z.uuid(),sha256:Sha}).strict();
export const ShadowResultSchema=z.object({format:z.literal('owner-draft-shadow-result-v1'),
  capture:Ref,observation:Ref.nullable(),featurePolicy:z.literal('selected-ten-and-known-series-exclusion-v1'),
  implementationSha256:Sha,calculatedAt:CaptureTimeSchema,
  candidate:z.object({sha256:Sha,artifactText:z.string().max(4*1024*1024)}).strict().nullable(),
  features:z.looseObject({status:z.enum(['ready_offline_features','unavailable']),reasons:z.array(z.string()),inputs:ShadowInputsSchema.nullable()}),
  status:z.enum(['computed_shadow_only','unavailable']),researchScores:ShadowScoresSchema.nullable(),reasons:z.array(z.string()),
  syntheticOnly:z.boolean(),primaryEligible:z.literal(false),deployable:z.literal(false),trainingPerformed:z.literal(false),
  forecastStatus:z.literal('unavailable'),teamAWinProbability:z.null()
}).strict().superRefine((r,ctx)=>{
  if(r.status==='computed_shadow_only'?(r.reasons.length!==0||r.features.inputs===null||r.researchScores===null||r.candidate===null):(!r.reasons.length||r.researchScores!==null))
    ctx.addIssue({code:'custom',message:'shadow_result_state'});
});
export type ShadowResult=z.infer<typeof ShadowResultSchema>;
export const ShadowSummarySchema=z.object({captureId:z.uuid(),status:z.enum(['missing','awaiting_receipt','computed_shadow_only','unavailable']),
  recordedAt:CaptureTimeSchema.nullable(),observedCommittedAt:CaptureTimeSchema.nullable(),sha256:Sha.nullable(),
  reasons:z.array(z.string()),primaryEligible:z.literal(false),teamAWinProbability:z.null()}).strict();
