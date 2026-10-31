import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
import {ProMapItemSchema} from './pro-maps.js';
import {SampleEvidenceSchema,SmoothingSchema,ReferencePoolSchema} from './sample.js';
const Time=z.iso.datetime({precision:3}),Count=z.number().int().nonnegative(),Role=z.number().int().min(1).max(5);
export const PlayerHeroQuerySchema=z.object({fromAt:Time.optional(),cutoffAt:Time.optional(),patchScope:z.enum(['current','all','specific']).default('current'),
  patchId:CatalogIdSchema.optional(),heroId:CatalogIdSchema.optional(),rolePos:z.coerce.number().int().min(1).max(5).optional(),
  side:z.enum(['radiant','dire']).optional(),opponentId:CatalogIdSchema.optional(),leagueId:CatalogIdSchema.optional()}).strict()
  .refine(q=>q.patchScope==='specific'?q.patchId!==undefined:q.patchId===undefined,{message:'Invalid patch selection'})
  .refine(q=>!q.fromAt||!q.cutoffAt||q.fromAt<q.cutoffAt,{message:'Invalid interval'});
export type PlayerHeroQuery=z.infer<typeof PlayerHeroQuerySchema>;
const Metric=z.object({value:z.number().nonnegative().nullable(),nMaps:Count}).strict();
export const PlayerHeroSampleSchema=z.object({nRaw:Count,wins:Count,winRate:z.number().min(0).max(1).nullable(),kda:Metric,
  meanKills:Metric,meanDeaths:Metric,meanAssists:Metric,meanGpm:Metric,meanXpm:Metric,lastPlayedAt:Time.nullable(),dataUpdatedAt:Time.nullable(),sampleEvidence:SampleEvidenceSchema}).strict();
const Stats=z.object({kills:Count.nullable(),deaths:Count.nullable(),assists:Count.nullable(),gpm:Count.nullable(),xpm:Count.nullable()}).strict();
const Metadata={playerId:CatalogIdSchema,filters:PlayerHeroQuerySchema,fromAt:Time,cutoffAt:Time,snapshotAt:Time,source:z.literal('normalized_local_maps'),
  policyVersion:z.literal('player-hero-display-v1'),scope:z.literal('retrospective_descriptive'),model:z.null(),predictionEligibility:z.literal('not_assessed')};
export const PlayerHeroReportSchema=z.object({...Metadata,status:z.enum(['ready','insufficient_data']),identityRevision:z.string(),registryRevision:z.string(),
  effectivePatchId:CatalogIdSchema.nullable(),summary:PlayerHeroSampleSchema,smoothing:SmoothingSchema,referencePool:ReferencePoolSchema,playerMapsInScope:Count,selectedHeroShare:z.number().min(0).max(1).nullable(),
  groups:z.array(PlayerHeroSampleSchema.extend({heroId:CatalogIdSchema.nullable(),heroName:z.string().nullable(),rolePos:Role.nullable(),heroMaps:Count,heroPickRate:z.number().min(0).max(1).nullable(),smoothing:SmoothingSchema})),
  coverage:z.object({candidates:Count,unknownPro:Count,nonPro:Count,conflict:Count,unfinished:Count,identityUnresolved:Count,filterMismatch:Count,heroFilterMismatch:Count,
    knownHero:Count,confirmedRole:Count,knownPatch:Count,lateFetchedMaps:Count,sourceFetchUnknown:Count}).strict(),
  patchDistribution:z.array(z.object({patchId:CatalogIdSchema.nullable(),maps:Count}).strict()),
  maps:z.array(ProMapItemSchema.extend({heroId:CatalogIdSchema.nullable(),stats:Stats})),warnings:z.array(z.string())}).strict();
export const PlayerHeroResponseSchema=z.union([PlayerHeroReportSchema,z.object({...Metadata,status:z.literal('unavailable'),reason:z.enum(['WINDOW_TOO_LARGE','CURRENT_PATCH_UNKNOWN']),message:z.string()}).strict()]);
export type PlayerHeroReport=z.infer<typeof PlayerHeroReportSchema>;
