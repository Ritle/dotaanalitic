import {z} from 'zod';
import {CatalogIdSchema as Id} from './catalog.js';
import {UpcomingMatchSchema} from './upcoming.js';
const Uuid=z.uuid().transform(v=>v.toLowerCase()),Sha=z.string().regex(/^[a-f0-9]{64}$/),Clock=z.iso.datetime({precision:6});
export const V1ScheduleTargetRequestSchema=z.object({requestId:Uuid,providerMatchId:Id,observationId:Id,observationSha256:Sha,
  expectedRevision:z.number().int().nonnegative().max(2147483646),mapNumber:z.literal(1),
  providerTeamAId:Id,providerTeamBId:Id,teamAId:Id,teamBId:Id,leagueId:Id.nullable(),
  reviewSourceUrl:z.url().refine(v=>new URL(v).protocol==='https:').max(2048),reason:z.string().trim().min(20).max(1000)
}).strict().refine(v=>v.providerTeamAId!==v.providerTeamBId&&v.teamAId!==v.teamBId);
export const V1ScheduleObservationSchema=z.object({id:Id,snapshotSha256:Sha,sourcePayloadSha256:Sha,
  fetchedAt:z.iso.datetime({precision:3}),recordedAt:Clock,knownAt:z.null(),endpoint:z.string(),adapterVersion:z.string(),match:UpcomingMatchSchema}).strict();
export const V1ScheduleTargetPreviewSchema=z.object({observation:V1ScheduleObservationSchema,omittingLaterPages:z.number().int().nonnegative(),
  checkedAt:Clock,eligible:z.boolean(),reasons:z.array(z.string())}).strict();
export const V1ScheduleTargetRecordSchema=z.object({format:z.literal('v1-schedule-target-v1'),provider:z.literal('pandascore'),
  request:V1ScheduleTargetRequestSchema,revision:z.number().int().positive(),previousSha256:Sha.nullable(),selectedAt:Clock,
  observation:V1ScheduleObservationSchema,omittingLaterPages:z.number().int().nonnegative(),
  mappingBasis:z.literal('owner_reviewed'),teamAName:z.string(),teamBName:z.string(),leagueName:z.string().nullable(),
  mapBinding:z.literal('pending'),probability:z.null(),warnings:z.array(z.string())}).strict();
export const V1ScheduleTargetSavedSchema=z.object({record:V1ScheduleTargetRecordSchema,sha256:Sha}).strict();
export const V1ScheduleTargetHistorySchema=z.object({items:z.array(V1ScheduleTargetSavedSchema).max(20),nextBeforeRevision:z.number().int().positive().nullable()}).strict();
export type V1ScheduleTargetRequest=z.infer<typeof V1ScheduleTargetRequestSchema>;
export type V1ScheduleObservation=z.infer<typeof V1ScheduleObservationSchema>;
export type V1ScheduleTargetSaved=z.infer<typeof V1ScheduleTargetSavedSchema>;
