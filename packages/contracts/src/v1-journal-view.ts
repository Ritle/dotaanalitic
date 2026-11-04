import { z } from 'zod';
import { CatalogIdSchema } from './catalog.js';
import { V1JournalSummarySchema } from './v1-journal.js';
import {V1JournalCurrentStatusSchema,V1JournalCurrentFiltersSchema} from './v1-journal-v2.js';
import {V1ScheduledLifecycleViewSchema} from './v1-scheduled-lifecycle.js';
import {V1LifecycleSavedSchema} from './v1-target-lifecycle.js';
import {V1ScheduleResultProofSchema} from './v1-forecast.js';
const Id=z.uuid(),Sha=z.string().regex(/^[a-f0-9]{64}$/),Clock=z.iso.datetime({precision:6});
export const V1JournalRowViewSchema=V1JournalSummarySchema.shape.rows.element.extend({
  scheduleResultBinding:V1ScheduleResultProofSchema.optional(),
  verifiedScheduleBindingKnown:z.boolean().optional(),
  status:V1JournalCurrentStatusSchema,lifecycle:z.union([V1LifecycleSavedSchema.omit({event:true}).extend({event:V1LifecycleSavedSchema.shape.event.omit({ownerId:true})}),V1ScheduledLifecycleViewSchema]).nullable().default(null),
  requestId:Id,snapshotSha256:Sha,purpose:z.enum(['what_if_single_map','real_map']),createdAt:Clock,issuedAt:Clock.nullable(),
  calculationStatus:z.enum(['done','unavailable']),attemptReasons:z.array(z.string()),
  cutoffAt:z.iso.datetime({precision:3}),probability:z.number().min(0).max(1).nullable(),modelId:Id.nullable(),
  scenario:z.object({id:Id,revision:z.number().int().positive(),title:z.string(),teamAId:CatalogIdSchema,teamBId:CatalogIdSchema}).strict(),
  expectedLineups:z.object({teamA:z.array(CatalogIdSchema).length(5),teamB:z.array(CatalogIdSchema).length(5)}).strict(),
  target:z.union([z.object({provider:z.literal('opendota'),providerSeriesId:CatalogIdSchema,mapNumber:z.literal(1)}).strict(),
    z.object({provider:z.literal('pandascore'),providerMatchId:CatalogIdSchema,mapNumber:z.literal(1),targetRequestId:Id,targetSha256:Sha}).strict()]).nullable(),
  outcomeSource:z.object({provider:z.literal('opendota'),receiptId:CatalogIdSchema,payloadSha256:Sha,
    fetchedAt:z.iso.datetime({precision:3}),verifiedAt:z.iso.datetime({precision:3}),dataRevision:z.string().regex(/^\d+$/)}).strict().nullable(),
  rosterStatus:z.enum(['matched','mismatched','unknown']).nullable(),actualWinner:z.enum(['A','B']).nullable(),
  sourceChangedSinceRefresh:z.boolean().nullable()
}).strict();
export const V1JournalViewSchema=z.object({requestId:Id,revision:z.number().int().positive(),sha256:Sha,inputSha256:Sha,
  previousSha256:Sha.nullable(),capturedAt:Clock,summary:V1JournalSummarySchema.omit({rows:true}).extend({filters:V1JournalCurrentFiltersSchema,counts:V1JournalSummarySchema.shape.counts.extend({cancelled:z.number().int().nonnegative().nullable()}),lifecyclePolicy:z.enum(['owner_reported_verified_binding_precedence_v1','owner_reported_verified_binding_precedence_v2']).optional()}),
  rows:z.array(V1JournalRowViewSchema).max(50),offset:z.number().int().nonnegative(),hasMore:z.boolean()}).strict();
export type V1JournalView=z.infer<typeof V1JournalViewSchema>;
export const V1JournalCodeChangedErrorSchema=z.object({error:z.object({code:z.literal('JOURNAL_CODE_CHANGED')})});
export const V1JournalHistorySchema=z.object({items:z.array(z.object({requestId:Id,revision:z.number().int().positive(),sha256:Sha,
  capturedAt:Clock,filters:V1JournalCurrentFiltersSchema,n:z.number().int().nonnegative(),accuracy:z.number().min(0).max(1).nullable()}).strict()).max(20),
  nextBeforeRevision:z.number().int().positive().nullable()}).strict();
