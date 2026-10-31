import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
const Time=z.iso.datetime({precision:3}),Us=z.string().regex(/^\d+$/),Count=z.number().int().nonnegative();
export const StrengthQuerySchema=z.object({fromAt:Time.optional(),cutoffAt:Time.optional(),limit:z.coerce.number().int().refine(n=>[20,50,100].includes(n)).default(20)}).strict()
  .refine(q=>!q.fromAt||!q.cutoffAt||q.fromAt<q.cutoffAt);
export type StrengthQuery=z.infer<typeof StrengthQuerySchema>;
export const StrengthProofSchema=z.object({id:CatalogIdSchema,field:z.enum(['pro_classification','radiant_win','context.lineup']),value:z.unknown(),
  eventAtUs:Us.nullable(),knownAtUs:Us.nullable(),fetchedAtUs:Us,evidenceRef:z.string().nullable(),reviewState:z.enum(['unverified','accepted','conflict','rejected']),
  availability:z.enum(['verified_asof','user_asserted_asof','retrospective_fact','unknown']),earliestStage:z.enum(['pre_match','post_draft','post_match'])}).strict();
export type StrengthProof=z.infer<typeof StrengthProofSchema>;
const Metadata={organizationId:CatalogIdSchema,filters:StrengthQuerySchema,fromAt:Time,cutoffAt:Time,snapshotAt:Time,source:z.literal('normalized_local_maps'),
  scope:z.literal('chronological_retrospective_participation'),policy:z.object({version:z.literal('player-mean-elo-v1'),initialRating:z.literal(1500),k:z.literal(32),scale:z.literal(400),validation:z.literal('unvalidated')}).strict(),
  model:z.null(),predictionEligibility:z.literal('not_assessed'),teamAWinProbability:z.null()};
export const StrengthReportSchema=z.object({...Metadata,status:z.enum(['ready','insufficient_data']),identityRevision:z.string(),replayStoppedAtUs:Us.nullable(),
  summary:z.object({nRaw:Count,wins:Count,winRate:z.number().min(0).max(1).nullable(),ratedMaps:Count,
    meanOpponentRatingBefore:z.number().nullable(),meanRatingChange:z.number().nullable(),lastObservedFiveRating:z.number().nullable(),lastObservedFiveFingerprint:z.string().nullable(),
    dataUpdatedAt:Time.nullable()}).strict(),
  coverage:z.object({globalCandidates:Count,unknownPro:Count,nonPro:Count,conflict:Count,unfinished:Count,identityUnavailable:Count,evidenceUnavailable:Count,
    globalReplayMaps:Count,updatesApplied:Count,pendingUpdates:Count,targetMapsBeforeLimit:Count,opponentPriorMaps:Count}).strict(),
  maps:z.array(z.object({matchId:CatalogIdSchema,startedAt:Time,startedAtUs:Us,endedAtUs:Us,side:z.enum(['radiant','dire']),won:z.boolean(),
    opponentId:CatalogIdSchema.nullable(),source:z.string(),syncedAt:Time,dataRevision:z.string(),
    rating:z.object({ownBefore:z.number(),opponentBefore:z.number(),change:z.number().nullable(),priorPlayers:Count,opponentPriorPlayers:Count,
      fingerprint:z.string(),opponentFingerprint:z.string(),availableAtUs:Us,updateApplied:z.boolean(),lineupKnownBeforeStart:z.boolean()}).strict().nullable(),
    identityProofIds:z.array(z.string()),factProofIds:z.array(CatalogIdSchema),reasons:z.array(z.string())}).strict()),
  replayManifest:z.array(z.object({matchId:CatalogIdSchema,startedAtUs:Us,availableAtUs:Us,dataRevision:z.string(),identityProofIds:z.array(z.string()),factProofIds:z.array(CatalogIdSchema)}).strict()),warnings:z.array(z.string())}).strict();
export const StrengthResponseSchema=z.union([StrengthReportSchema,z.object({...Metadata,status:z.literal('unavailable'),reason:z.literal('GLOBAL_HISTORY_TOO_LARGE'),message:z.string()}).strict()]);
export type StrengthReport=z.infer<typeof StrengthReportSchema>;
