import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
const Id=CatalogIdSchema,Time=z.iso.datetime({precision:3}),Name=z.string().max(200).nullable();
export const UpcomingMatchSchema=z.object({providerMatchId:Id,name:Name,status:z.string().max(40),scheduledAt:Time.nullable(),
  tournament:z.object({providerTournamentId:Id,name:Name}).strict(),league:z.object({providerLeagueId:Id,name:Name}).strict(),
  eventSeries:z.object({providerEventSeriesId:Id,name:Name}).strict().nullable(),seriesBestOf:z.number().int().min(1).max(20).nullable(),
  opponents:z.array(z.object({providerTeamId:Id,name:Name}).strict()).max(2)}).strict();
export const ExpectedTeamSchema=z.object({providerTeamId:Id,name:Name,
  players:z.array(z.object({providerPlayerId:Id,name:Name}).strict()).max(30)}).strict();
export const ScheduleSourceSchema=z.object({provider:z.literal('pandascore'),adapterVersion:z.string().max(80),
  endpoint:z.string().regex(/^\/(?:dota2\/matches\/upcoming\?sort=scheduled_at,id&page=1&per_page=20|tournaments\/[1-9]\d{0,18}\/rosters)$/),
  fetchedAt:Time,knownAt:z.null(),payloadSha256:z.string().regex(/^[a-f0-9]{64}$/),attempts:z.number().int().min(1).max(2),
  rateLimitRemaining:z.number().int().nonnegative().nullable()}).strict();
export const ScheduleCacheDataSchema=z.object({data:z.array(UpcomingMatchSchema).max(20),source:ScheduleSourceSchema}).strict();
export const RostersCacheDataSchema=z.object({data:z.array(ExpectedTeamSchema).max(100),source:ScheduleSourceSchema}).strict();
const CacheMeta=z.object({status:z.enum(['ready','stale','unavailable']),computedAt:Time,expiresAt:Time.nullable(),
  retryAt:Time.nullable(),refreshing:z.boolean(),configured:z.boolean(),
  reason:z.enum(['not_loaded','not_configured','refresh_in_progress','cooldown','source_unavailable','invalid_cached_data']).nullable()});
export const UpcomingScheduleResponseSchema=CacheMeta.extend({snapshot:ScheduleCacheDataSchema.nullable()}).strict();
export const UpcomingRostersResponseSchema=CacheMeta.extend({snapshot:RostersCacheDataSchema.nullable()}).strict();
export type UpcomingMatch=z.infer<typeof UpcomingMatchSchema>;
export type ExpectedTeam=z.infer<typeof ExpectedTeamSchema>;
export type UpcomingScheduleResponse=z.infer<typeof UpcomingScheduleResponseSchema>;
export type UpcomingRostersResponse=z.infer<typeof UpcomingRostersResponseSchema>;
