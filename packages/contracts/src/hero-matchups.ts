import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
import {DraftWeightPolicySchema} from './patch-history.js';
import {SampleEvidenceSchema} from './sample.js';
const Time=z.iso.datetime({precision:3}),Count=z.number().int().nonnegative(),Rate=z.number().min(0).max(1).nullable();
export const HeroMatchupQuerySchema=z.object({expectedRevision:z.number().int().positive(),fromAt:Time.optional(),
  patchScope:z.enum(['all','current','specific']).default('all'),patchId:CatalogIdSchema.optional(),leagueId:CatalogIdSchema.optional(),
  weights:DraftWeightPolicySchema.optional()}).strict().refine(q=>q.patchScope==='specific'?q.patchId!==undefined:q.patchId===undefined);
export type HeroMatchupQuery=z.infer<typeof HeroMatchupQuerySchema>;
const Hero=z.object({teamSlot:z.enum(['A','B']),rolePos:z.number().int().min(1).max(5),heroId:z.number().int().positive(),name:z.string()}).strict();
const Distribution=z.array(z.object({patchId:CatalogIdSchema.nullable(),nRaw:Count}).strict());
const Prior=z.object({alpha:Count,beta:Count,mean:Rate,mass:Count,patchId:CatalogIdSchema,beforeAt:Time,matchIds:z.array(CatalogIdSchema),seriesIds:z.array(z.uuid())}).strict();
const Smoothing=z.object({status:z.enum(['available','unavailable']),validation:z.literal('unvalidated_descriptive'),policyVersion:z.literal('pair-reference-beta-v1'),
  estimate:Rate,priorOnly:z.boolean(),prior:Prior.nullable(),reason:z.string().nullable()}).strict();
const Weighted=z.object({status:z.enum(['disabled','unavailable','computed_candidate']),validation:z.literal('unvalidated_candidate'),
  rate:Rate,nEff:z.number().nonnegative().nullable(),nKnown:Count,nPositive:Count,nMissing:Count,targetPatchId:CatalogIdSchema.nullable(),
  patchColdStart:z.boolean().nullable(),cacheKey:z.string().nullable(),reasons:z.array(z.string()),
  maps:z.array(z.object({matchId:CatalogIdSchema,weight:z.number().nonnegative().nullable(),reasons:z.array(z.string()),proofIds:z.array(z.string())}).strict())}).strict();
export const HeroPairStatSchema=z.object({kind:z.enum(['ally','enemy']),teamSlot:z.enum(['A','B']).nullable(),heroA:Hero,heroB:Hero,
  nRaw:Count,wins:Count,winRate:Rate,sampleEvidence:SampleEvidenceSchema,patchDistribution:Distribution,smoothing:Smoothing,weighted:Weighted}).strict();
export type HeroPairStat=z.infer<typeof HeroPairStatSchema>;
const Coverage=z.object({candidates:Count,unknownPro:Count,nonPro:Count,conflict:Count,unfinished:Count,outsideWindow:Count,filterMismatch:Count,
  eligibleMaps:Count,partialHeroMaps:Count,invalidHeroRows:Count,unknownPatchMaps:Count,unverifiedSeriesMaps:Count,lateFetchedMaps:Count}).strict();
const Manifest=z.object({matchId:CatalogIdSchema,startedAt:Time,radiantWin:z.boolean(),heroes:z.array(z.object({heroId:z.number().int().positive(),side:z.enum(['radiant','dire'])}).strict()),
  patchId:CatalogIdSchema.nullable(),seriesId:z.uuid().nullable(),dataRevision:z.string(),source:z.string(),syncedAt:Time,sourceFetchedAt:Time.nullable(),patchProofIds:z.array(z.string()),seriesProofIds:z.array(z.string())}).strict();
export const HeroMatchupReportSchema=z.object({status:z.enum(['ready','insufficient_data']),scope:z.literal('retrospective_hero_pairs'),policyVersion:z.literal('hero-pairs-v1'),
  scenarioId:z.uuid(),scenarioRevision:Count,scenarioInputHash:z.string(),query:HeroMatchupQuerySchema,snapshotAt:Time,requestedCutoffAt:Time,cutoffAt:Time,fromAt:Time,
  currentPatchId:CatalogIdSchema.nullable(),effectivePatchId:CatalogIdSchema.nullable(),targetLeagueId:CatalogIdSchema.nullable(),registryRevision:z.string(),fingerprint:z.string(),
  heroes:z.array(Hero),allies:z.array(HeroPairStatSchema),enemies:z.array(HeroPairStatSchema),coverage:Coverage,
  reference:z.object({status:z.enum(['ready','unavailable']),reason:z.string().nullable(),beforeAt:Time,coverage:Coverage.nullable(),excludedSeriesIds:z.array(z.uuid()),provenance:z.array(Manifest)}).strict(),
  provenance:z.array(Manifest),dataUpdatedAt:Time.nullable(),warnings:z.array(z.string()),model:z.null(),teamAWinProbability:z.null()}).strict();
export type HeroMatchupReport=z.infer<typeof HeroMatchupReportSchema>;
export const HeroMatchupResponseSchema=z.union([HeroMatchupReportSchema,z.object({status:z.literal('unavailable'),reason:z.enum(['WINDOW_TOO_LARGE','TARGET_PATCH_UNKNOWN','INSUFFICIENT_DRAFT']),
  scenarioId:z.uuid(),scenarioRevision:Count,snapshotAt:Time,cutoffAt:Time,fromAt:Time,message:z.string()}).strict()]);
