import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
const Time=z.iso.datetime({precision:3}),Role=z.number().int().min(1).max(5),Count=z.number().int().nonnegative();
const SourceId=z.union([z.string().regex(/^[1-9]\d*$/),z.number().int().positive().safe()]).transform(String);
export const RoleLanePayloadSchema=z.object({match_id:SourceId,start_time:z.number().int().positive(),duration:z.number().int().positive(),radiant_win:z.boolean(),
  players:z.array(z.object({player_slot:z.number().int(),account_id:SourceId,lane_role:z.number().int().nullable().optional(),
    gold_per_min:z.number().int().nonnegative().nullable().optional()})).max(10)});
export const RoleSuggestionRequestSchema=z.object({playerIds:z.array(CatalogIdSchema).min(1).max(5),cutoffAt:Time.optional()}).strict()
  .refine(v=>new Set(v.playerIds).size===v.playerIds.length,{message:'Duplicate players'});
export const RoleSuggestionReportSchema=z.object({
  status:z.enum(['ready','partial','unavailable']),scope:z.literal('current_descriptive_suggestion'),
  policyVersion:z.literal('role-suggestion-lane-gpm-v1'),snapshotAt:Time,cutoffAt:Time,fromAt:Time,
  maxMapsPerPlayer:z.literal(20),windowDays:z.literal(90),source:z.literal('normalized_local_pro_maps'),
  model:z.null(),warnings:z.array(z.string()),
  players:z.array(z.object({playerId:CatalogIdSchema,suggestedRole:Role.nullable(),
    basis:z.enum(['confirmed_history','lane_gpm_estimate','unknown']),nRaw:Count,nUsed:Count,topCount:Count,
    lastMatchAt:Time.nullable(),reasons:z.array(z.string()),
    distribution:z.array(z.object({rolePos:Role,maps:Count})),
    evidence:z.array(z.object({matchId:CatalogIdSchema,startedAt:Time,rolePos:Role,
      basis:z.enum(['confirmed_history','lane_gpm_estimate']),proofIds:z.array(z.string()),
      identityProofIds:z.array(z.string()),fetchedAt:Time.nullable()}))
  })).max(5)
}).strict();
export type RoleSuggestionReport=z.infer<typeof RoleSuggestionReportSchema>;
export type RoleSuggestionRequest=z.infer<typeof RoleSuggestionRequestSchema>;
