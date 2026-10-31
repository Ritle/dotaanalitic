import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
const Time=z.iso.datetime({precision:3});
export const ProMapQuerySchema=z.object({
  fromAt:Time.optional(),cutoffAt:Time.optional(),patchId:CatalogIdSchema.optional(),
  opponentId:CatalogIdSchema.optional(),playerId:CatalogIdSchema.optional(),leagueId:CatalogIdSchema.optional(),
  rolePos:z.coerce.number().int().min(1).max(5).optional(),side:z.enum(['radiant','dire']).optional(),
  limit:z.coerce.number().int().refine(n=>[10,20,50,100].includes(n)).default(20)
}).strict().refine(q=>!q.fromAt||!q.cutoffAt||q.fromAt<q.cutoffAt,{message:'Invalid date interval'});
export type ProMapQuery=z.infer<typeof ProMapQuerySchema>;
export const ProMapItemSchema=z.object({
  matchId:CatalogIdSchema,startedAt:Time,side:z.enum(['radiant','dire']),won:z.boolean(),durationSeconds:z.number().int().positive(),
  organizationId:CatalogIdSchema.nullable(),opponentId:CatalogIdSchema.nullable(),leagueId:CatalogIdSchema.nullable(),
  patchId:CatalogIdSchema.nullable(),seriesId:z.uuid().nullable(),seriesStatus:z.enum(['verified','unknown','conflict']),rolePos:z.number().int().min(1).max(5).nullable(),
  completeCanonicalRoster:z.boolean(),source:z.string(),syncedAt:Time,sourceFetchedAt:Time.nullable(),dataRevision:z.string(),
  identityProofIds:z.array(z.string()),roleProofIds:z.array(z.string()),patchProofIds:z.array(z.string()),seriesProofIds:z.array(z.string()),warnings:z.array(z.string())
}).strict();
export const ProMapReportSchema=z.object({
  status:z.enum(['ready','insufficient_data']),scope:z.literal('retrospective_descriptive'),policyVersion:z.literal('pro-map-display-v1'),
  entityType:z.enum(['organization','canonical_player']),entityId:CatalogIdSchema,
  filters:ProMapQuerySchema.safeExtend({cutoffAt:Time}),snapshotAt:Time,computedAt:Time,source:z.literal('normalized_local_maps'),
  identityRevision:z.string(),registryRevision:z.string(),model:z.null(),predictionEligibility:z.literal('not_assessed'),
  summary:z.object({nRaw:z.number().int().nonnegative(),wins:z.number().int().nonnegative(),losses:z.number().int().nonnegative(),
    winRate:z.number().min(0).max(1).nullable(),meanDurationSeconds:z.number().nonnegative().nullable(),dataUpdatedAt:Time.nullable()}).strict(),
  coverage:z.object({candidates:z.number().int().nonnegative(),unknownPro:z.number().int().nonnegative(),nonPro:z.number().int().nonnegative(),
    conflict:z.number().int().nonnegative(),unfinished:z.number().int().nonnegative(),identityUnresolved:z.number().int().nonnegative(),
    filterMismatch:z.number().int().nonnegative(),eligibleBeforeLimit:z.number().int().nonnegative(),
    knownPatch:z.number().int().nonnegative(),completeCanonicalRosters:z.number().int().nonnegative(),knownSeries:z.number().int().nonnegative(),
    knownOpponent:z.number().int().nonnegative(),confirmedTargetRole:z.number().int().nonnegative(),lateFetchedMaps:z.number().int().nonnegative(),
    unattributedOrganizationMapsInWindow:z.number().int().nonnegative()}).strict(),
  patchDistribution:z.array(z.object({patchId:CatalogIdSchema.nullable(),maps:z.number().int().positive()}).strict()),
  maps:z.array(ProMapItemSchema),warnings:z.array(z.string())
}).strict();
export const ProMapResponseSchema=z.union([ProMapReportSchema,z.object({status:z.literal('unavailable'),reason:z.literal('WINDOW_TOO_LARGE'),
  message:z.string(),maxCandidates:z.literal(5000)}).strict()]);
export type ProMapReport=z.infer<typeof ProMapReportSchema>;
export type ProMapItem=z.infer<typeof ProMapItemSchema>;
