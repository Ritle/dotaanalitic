import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
const Time=z.iso.datetime({precision:3}),N=z.number().int().min(0).max(50);
export const PlayerHistoryOptionsSchema=z.object({windowDays:z.union([z.literal(90),z.literal(180),z.literal(365),z.literal(730)]).default(90),
 maxMaps:z.union([z.literal(10),z.literal(25),z.literal(50)]).default(10)}).strict();
export type PlayerHistoryOptions=z.infer<typeof PlayerHistoryOptionsSchema>;
export const SelectedPlayerHistoryRequestSchema=PlayerHistoryOptionsSchema.extend({playerIds:z.array(CatalogIdSchema).length(5).refine(a=>new Set(a).size===5)}).strict();
export const PlayerHistoryBindingSchema=z.object({playerId:CatalogIdSchema,accountId:CatalogIdSchema.refine(id=>BigInt(id)<=4294967295n)}).strict();
export const HistoryEnrichmentSchema=z.object({status:z.enum(['completed','partial','unavailable']),accountsConsidered:z.number().int().min(0).max(500),accountsVerified:z.number().int().min(0).max(100),
 profilesRequested:z.number().int().min(0).max(20),unresolvedAccounts:z.array(CatalogIdSchema).max(500),seriesCreated:N,seriesBlocked:z.array(CatalogIdSchema).max(50),replayedMaps:N,
 reasons:z.array(z.string().max(100)).max(20),assessedAt:Time.nullable(),players:z.array(PlayerHistoryBindingSchema.extend({rawMaps:z.number().int().nonnegative(),eligibleMaps:z.number().int().nonnegative()})).max(5)}).strict();
export type HistoryEnrichment=z.infer<typeof HistoryEnrichmentSchema>;
export const PlayerHistoryReportSchema=z.object({policyVersion:z.enum(['selected-player-history-v1','selected-player-history-v2','selected-player-history-v3','selected-player-history-v4']),cutoffAt:Time,fromAt:Time,fetchedAt:Time,
 operation:z.literal('evidence_resume').optional(),parentRunId:z.uuid().optional(),
 enrichment:HistoryEnrichmentSchema.optional(),
 options:PlayerHistoryOptionsSchema.optional(),discoveryPages:z.number().int().min(1).max(5).optional(),
 selected:N,accepted:N,duplicates:N,excluded:N,failed:N,conflicts:N,
 players:z.array(PlayerHistoryBindingSchema.extend({discovered:N,selected:N,accepted:N,sourceLimitReached:z.boolean().optional()})).length(5),
 maps:z.array(z.object({matchId:CatalogIdSchema,status:z.enum(['accepted','duplicate','excluded','error','conflict']),reasons:z.array(z.string().max(100)).max(30)}).strict()).max(50)
}).strict().superRefine((r,ctx)=>{
 if(r.policyVersion==='selected-player-history-v4'?(r.operation!=='evidence_resume'||!r.parentRunId):(r.operation!==undefined||r.parentRunId!==undefined))
  ctx.addIssue({code:'custom',message:'Resume reports require an explicit operation, parent and v4 policy.'});
});
export const PlayerHistoryRunSchema=z.object({id:z.uuid(),status:z.enum(['queued','running','completed','partial','error']),createdAt:Time,finishedAt:Time.nullable(),
 operation:z.enum(['import','evidence_resume']).optional(),parentRunId:z.uuid().nullable().optional(),
 report:PlayerHistoryReportSchema.nullable(),errorCode:z.enum(['source_unavailable','import_failed','identity_changed','worker_unavailable']).nullable()}).strict();
export const PlayerHistoryResumeRequestSchema=z.object({runId:z.uuid()}).strict();
const StoredHistoryAudit=z.object({sources:z.array(z.object({endpoint:z.string(),payloadSha256:z.string().regex(/^[a-f0-9]{64}$/),fetchedAt:z.iso.datetime()}))});
export const PlayerHistorySourceAuditSchema=StoredHistoryAudit.or(z.object({capture:StoredHistoryAudit}).transform(v=>v.capture));
export const PlayerHistoryReferenceIdsSchema=z.object({hero_reference_id:CatalogIdSchema,league_reference_id:CatalogIdSchema});
export const PlayerHistoryResponseSchema=z.object({playerIds:SelectedPlayerHistoryRequestSchema.shape.playerIds,options:PlayerHistoryOptionsSchema.optional(),available:z.boolean(),run:PlayerHistoryRunSchema.nullable(),retryAt:Time.nullable(),message:z.string().max(500),canResume:z.boolean().optional()}).strict();
export type PlayerHistoryBinding=z.infer<typeof PlayerHistoryBindingSchema>;
export type PlayerHistoryReport=z.infer<typeof PlayerHistoryReportSchema>;
export type PlayerHistoryRun=z.infer<typeof PlayerHistoryRunSchema>;
