import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
import {UpcomingMatchSchema,ExpectedTeamSchema} from './upcoming.js';

export const UpcomingEvidenceRequestSchema=z.object({providerMatchId:CatalogIdSchema,
  cutoffAt:z.iso.datetime({precision:3})}).strict();
const Observation=z.object({id:CatalogIdSchema,provider:z.literal('pandascore'),endpoint:z.string(),
  sourceFetchedAt:z.iso.datetime({precision:6}),recordedAt:z.iso.datetime({precision:6}),
  sourcePayloadSha256:z.string().regex(/^[a-f0-9]{64}$/),snapshotSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const UpcomingEvidenceReasonSchema=z.enum(['schedule_not_observed','schedule_history_limit',
  'opponents_incomplete','roster_not_observed','opponent_roster_missing','empty_roster','roster_player_conflict']);
export const UpcomingEvidenceReportSchema=z.object({schemaVersion:z.literal(1),
  policyVersion:z.literal('upcoming-observations-asof-v1'),request:UpcomingEvidenceRequestSchema,
  status:z.enum(['observed','partial','unavailable']),reasons:z.array(UpcomingEvidenceReasonSchema),
  scheduleRowsExamined:z.number().int().min(0).max(200),laterSchedulePagesOmittingMatch:z.number().int().min(0).max(200),
  schedule:z.object({observation:Observation,match:UpcomingMatchSchema}).strict().nullable(),
  roster:z.object({observation:Observation,teams:z.array(ExpectedTeamSchema).max(2)}).strict().nullable(),
  mapBinding:z.literal('not_assessed'),lineupVerification:z.literal('not_assessed'),
  trainingReady:z.literal(false),deployable:z.literal(false)}).strict();
export type UpcomingEvidenceReport=z.infer<typeof UpcomingEvidenceReportSchema>;
export type UpcomingEvidenceReason=z.infer<typeof UpcomingEvidenceReasonSchema>;
