import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
const Time=z.iso.datetime({precision:3}),Text=z.string().trim().min(1).max(512);
const clocks={eventAt:Time,knownAt:Time,fetchedAt:Time,source:Text,evidenceRef:Text,
  reviewState:z.enum(['accepted','unverified','conflict','rejected'])};
const clockCheck=(r:{eventAt:string;knownAt:string;fetchedAt:string},ctx:z.RefinementCtx)=>{
  if(r.eventAt>r.fetchedAt||r.knownAt>r.fetchedAt)ctx.addIssue({code:'custom',message:'Invalid evidence clocks'});
};
export const PatchTransitionEvidenceSchema=z.object({...clocks,fromPatchId:CatalogIdSchema,patchId:CatalogIdSchema,
  changeLevel:z.enum(['minor','moderate','major'])}).strict().superRefine((r,ctx)=>{
  clockCheck(r,ctx);if(r.fromPatchId===r.patchId)ctx.addIssue({code:'custom',message:'Transition must change patch'});
});
export const HeroImpactEvidenceSchema=z.object({...clocks,patchId:CatalogIdSchema,heroId:z.number().int().positive().max(2147483647),
  impactLevel:z.enum(['unchanged','minor','moderate','major','rework'])}).strict().superRefine(clockCheck);
const Penalties=z.object({minor:z.number().finite().nonnegative(),moderate:z.number().finite().nonnegative(),major:z.number().finite().nonnegative()}).strict();
const Factors=z.object({unchanged:z.literal(1),minor:z.number().min(0).max(1),moderate:z.number().min(0).max(1),
  major:z.number().min(0).max(1),rework:z.number().min(0).max(1)}).strict();
export const DraftDecaySchema=z.object({halfLifeDays:z.number().finite().positive(),transitionPenalties:Penalties,heroFactors:Factors}).strict();
export const DraftWeightPolicySchema=z.object({version:Text,validation:z.literal('unvalidated_candidate'),draft:DraftDecaySchema}).strict();
export const HistoryWeightPolicySchema=z.object({version:Text,validation:z.literal('unvalidated_candidate'),
  draft:DraftDecaySchema,
  strength:z.object({halfLifeDays:z.number().finite().positive(),transitionPenalties:Penalties}).strict()}).strict();
export const PatchHistoryRequestSchema=z.object({cutoffAt:Time,feature:z.enum(['draft_hero','strength']),leagueId:CatalogIdSchema.nullable(),
  heroIds:z.array(z.number().int().positive().max(2147483647)).max(10),
  maps:z.array(z.object({matchId:CatalogIdSchema,startedAt:Time}).strict()).max(5000),policy:HistoryWeightPolicySchema}).strict().superRefine((r,ctx)=>{
  if(new Set(r.maps.map(m=>m.matchId)).size!==r.maps.length||new Set(r.heroIds).size!==r.heroIds.length||
    r.maps.some(m=>m.startedAt>=r.cutoffAt)||r.feature==='draft_hero'&&r.heroIds.length===0||r.feature==='strength'&&r.heroIds.length!==0)
    ctx.addIssue({code:'custom',message:'Invalid history scope or cutoff'});
});
export type PatchTransitionEvidence=z.infer<typeof PatchTransitionEvidenceSchema>;
export type HeroImpactEvidence=z.infer<typeof HeroImpactEvidenceSchema>;
export type HistoryWeightPolicy=z.infer<typeof HistoryWeightPolicySchema>;
export type PatchHistoryRequest=z.infer<typeof PatchHistoryRequestSchema>;
export const DraftHistoryRequestSchema=z.object({cutoffAt:Time,feature:z.literal('draft_hero'),leagueId:CatalogIdSchema.nullable(),
  heroIds:z.array(z.number().int().positive().max(2147483647)).min(1).max(10),
  maps:z.array(z.object({matchId:CatalogIdSchema,startedAt:Time}).strict()).max(5000),policy:DraftWeightPolicySchema}).strict().superRefine((r,ctx)=>{
    if(new Set(r.maps.map(m=>m.matchId)).size!==r.maps.length||new Set(r.heroIds).size!==r.heroIds.length||r.maps.some(m=>m.startedAt>=r.cutoffAt))
      ctx.addIssue({code:'custom',message:'Invalid draft history scope or cutoff'});
  });
export type DraftHistoryRequest=z.infer<typeof DraftHistoryRequestSchema>;
const EvaluationRow=z.object({matchId:CatalogIdSchema,seriesId:z.uuid(),startedAt:Time,endedAt:Time,labelKnownAt:Time,
  won:z.boolean(),isPro:z.literal(true),outcomeEvidenceRef:z.string().trim().min(1),split:z.enum(['train','calibration','validation','test'])}).strict();
export const PatchWeightEvaluationSchema=z.object({datasetSha256:z.string().regex(/^[0-9a-f]{64}$/),
  codeRevision:z.string().trim().min(1),cohortKey:z.string().trim().min(1),origin:z.enum(['synthetic','verified_pro']),
  policyFrozenAt:Time,policy:HistoryWeightPolicySchema,feature:z.enum(['draft_hero','strength']),
  heroIds:z.array(z.number().int().positive()).max(10),leagueId:CatalogIdSchema.nullable(),maps:z.array(EvaluationRow).min(4).max(500)}).strict();
export type PatchWeightEvaluationInput=z.infer<typeof PatchWeightEvaluationSchema>;
