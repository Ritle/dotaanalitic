import {z} from 'zod';
import {ScenarioSnapshotSchema} from './scenario.js';
import {HeroMatchupQuerySchema,HeroMatchupResponseSchema} from './hero-matchups.js';
import {CompareReportSchema} from './compare.js';
import {PlayerHeroResponseSchema} from './player-hero.js';
import {CatalogIdSchema} from './catalog.js';
const Time=z.iso.datetime({precision:3}),Count=z.number().int().nonnegative();
export const ScenarioReportQuerySchema=HeroMatchupQuerySchema;
export type ScenarioReportQuery=z.infer<typeof ScenarioReportQuerySchema>;
export const ScenarioReportBodySchema=z.object({policyVersion:z.literal('scenario-report-v1'),scope:z.literal('retrospective_descriptive'),
  status:z.enum(['ready','insufficient_data']),scenario:ScenarioSnapshotSchema,query:ScenarioReportQuerySchema,
  fromAt:Time,cutoffAt:Time,snapshotAt:Time,effectivePatchId:CatalogIdSchema.nullable(),
  lineupEvidence:z.object({source:z.literal('owner_assertion'),recordedAt:Time,historicalAvailability:z.literal('unverified')}).strict(),
  comparison:CompareReportSchema,
  players:z.array(z.object({teamSlot:z.enum(['A','B']),rolePos:z.number().int().min(1).max(5),playerId:CatalogIdSchema,heroId:z.number().int().positive().nullable(),heroName:z.string().nullable(),report:PlayerHeroResponseSchema}).strict()).length(10),
  pairs:HeroMatchupResponseSchema,
  heroMeta:z.array(z.object({heroId:z.number().int().positive(),name:z.string(),nRaw:Count,wins:Count,winRate:z.number().min(0).max(1).nullable(),
    knownDraftPicks:Count,completeDraftMaps:Count,pickRate:z.number().min(0).max(1).nullable(),patchDistribution:z.array(z.object({patchId:CatalogIdSchema.nullable(),nRaw:Count}).strict()),dataUpdatedAt:Time.nullable()}).strict()),
  coverage:z.object({candidates:Count,eligibleProMaps:Count,unknownPatchMaps:Count,unknownSeriesMaps:Count,partialHeroMaps:Count,sourceFetchUnknown:Count,lateFetchedMaps:Count}).strict(),
  provenance:z.object({identityRevision:z.string(),registryRevision:z.string(),registryFingerprint:z.string(),referenceFingerprint:z.string().nullable(),strengthFingerprint:z.string().nullable(),referenceStatus:z.enum(['ready','unavailable']),
    maps:z.array(z.object({matchId:CatalogIdSchema,startedAt:Time,included:z.boolean(),isPro:z.boolean().nullable(),completed:z.boolean(),conflict:z.boolean(),dataRevision:z.string(),source:z.string(),syncedAt:Time,sourceFetchedAt:Time.nullable()}).strict())}).strict(),
  prediction:z.object({status:z.literal('unavailable'),model:z.null(),teamAWinProbability:z.null(),reasons:z.array(z.string())}).strict(),warnings:z.array(z.string())}).strict();
export type ScenarioReportBody=z.infer<typeof ScenarioReportBodySchema>;
export const ScenarioReportSchema=z.object({id:z.uuid(),version:z.number().int().positive(),createdAt:Time,resultHash:z.string().regex(/^[a-f0-9]{64}$/),report:ScenarioReportBodySchema}).strict();
export type ScenarioReport=z.infer<typeof ScenarioReportSchema>;
export const ScenarioReportUnavailableSchema=z.object({status:z.literal('unavailable'),reason:z.enum(['WINDOW_TOO_LARGE','TARGET_PATCH_UNKNOWN']),message:z.string()}).strict();
export const ScenarioReportCreateSchema=z.union([ScenarioReportSchema,ScenarioReportUnavailableSchema]);
export const ScenarioReportHistorySchema=z.object({items:z.array(z.object({id:z.uuid(),version:z.number().int().positive(),scenarioRevision:z.number().int().positive(),createdAt:Time,
  status:z.enum(['ready','insufficient_data']),fromAt:Time,cutoffAt:Time,policyVersion:z.string(),resultHash:z.string()}).strict()),hasMore:z.boolean()}).strict();
