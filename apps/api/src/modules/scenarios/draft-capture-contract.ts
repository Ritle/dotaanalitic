import {z} from 'zod';
import {ScenarioInputSchema,CatalogIdSchema,Steam32Schema,AccountEvidenceSchema} from '@dota/contracts';
const Hash=z.string().regex(/^[a-f0-9]{64}$/);
export const CaptureTimeSchema=z.iso.datetime({precision:6});
export const DraftCaptureRequestSchema=z.object({expectedRevision:z.number().int().positive().max(2147483646),scheduleTargetRequestId:z.uuid().nullable().optional()}).strict();
export const DraftCaptureIdentitySchema=AccountEvidenceSchema.safeExtend({observationId:z.string().min(1)});
export const DraftCapturePlayerSchema=z.object({teamSlot:z.enum(['A','B']),rolePos:z.number().int().min(1).max(5),
  playerId:CatalogIdSchema,heroId:z.number().int().positive().nullable(),accountId:Steam32Schema.nullable(),
  identityStatus:z.enum(['verified','missing','ambiguous']),observationIds:z.array(z.string())}).strict();
const Row=z.record(z.string(),z.unknown());
const Us=z.string().regex(/^-?\d{1,20}$/);
const MapRow=z.object({id:CatalogIdSchema,series_id:z.uuid().nullable(),started_at_us:Us,synced_at_us:Us,
  duration_seconds:z.number().int().nonnegative().nullable(),radiant_win:z.boolean().nullable(),is_pro:z.literal(true),
  ingest_state:z.enum(['partial','accepted','conflict']),data_revision:z.string().regex(/^\d+$/),patch_id:CatalogIdSchema.nullable(),
  radiant_team_id:CatalogIdSchema.nullable(),dire_team_id:CatalogIdSchema.nullable()}).strict();
const PlayerRow=z.object({match_id:CatalogIdSchema,player_slot:z.number().int(),side:z.enum(['radiant','dire']),
  player_id:CatalogIdSchema.nullable(),source_account_id:Steam32Schema.nullable(),hero_id:z.number().int().nullable()}).strict();
const ReceiptRow=z.object({id:CatalogIdSchema,canonical_match_id:CatalogIdSchema,provider:z.string(),provider_match_id:z.string(),
  adapter_version:z.string(),normalizer_version:z.string(),payload_sha256:Hash,context_sha256:Hash,
  status:z.enum(['received','accepted','partial','conflict','quarantined']),reasons:z.array(z.unknown()),
  event_at_us:Us.nullable(),known_at_us:Us.nullable(),fetched_at_us:Us,source_payload:Row}).strict();
const FactRow=z.object({id:CatalogIdSchema,match_id:CatalogIdSchema,receipt_id:CatalogIdSchema.nullable(),field_name:z.string(),
  value:z.unknown(),value_sha256:Hash,provider:z.string(),adapter_version:z.string(),evidence_ref:z.string().nullable(),
  review_state:z.enum(['unverified','accepted','conflict','rejected']),availability_class:z.string(),earliest_stage:z.string(),
  event_at_us:Us.nullable(),known_at_us:Us.nullable(),fetched_at_us:Us,recorded_at_us:Us}).strict();
const SeriesRow=z.object({id:z.uuid(),provider:z.string().nullable(),provider_series_id:z.string().nullable(),
  team_a_id:CatalogIdSchema.nullable(),team_b_id:CatalogIdSchema.nullable()}).strict();
// Evidence rows are projections, not model inputs. Their original clocks and hashes are preserved.
export const DraftCaptureHistorySchema=z.object({status:z.enum(['captured','unavailable']),
  scope:z.literal('all_local_pro_before_decision_remote_completeness_unknown'),
  maps:z.array(MapRow).max(5000),players:z.array(PlayerRow).max(50000),receipts:z.array(ReceiptRow).max(10000),
  facts:z.array(FactRow).max(200000),identities:z.array(DraftCaptureIdentitySchema).max(50000),
  series:z.array(SeriesRow).max(5000),sha256:Hash}).strict();
export const DraftCaptureSnapshotSchema=z.object({format:z.literal('owner-draft-capture-v1'),
  scenarioId:z.uuid(),revision:z.number().int().positive(),scheduleTargetRequestId:z.uuid().nullable(),scenarioHash:Hash,scenarioRecordedAt:CaptureTimeSchema,
  scenario:ScenarioInputSchema,decisionCutoffAt:CaptureTimeSchema,
  players:z.array(DraftCapturePlayerSchema).length(10),identityEvidence:z.array(DraftCaptureIdentitySchema).max(50000),
  target:z.object({status:z.literal('pending'),provider:z.string().min(1).max(64),providerSeriesId:z.string().min(1).max(128),
    mapNumber:z.number().int().min(1).max(5),actualMatchId:z.null(),evidence:Row}).strict().nullable(),
  history:DraftCaptureHistorySchema,status:z.enum(['captured','unavailable']),reasons:z.array(z.string()),
  warnings:z.array(z.string()),primaryEligible:z.literal(false),scoringPerformed:z.literal(false),deployable:z.literal(false)
}).strict();
export type DraftCaptureSnapshot=z.infer<typeof DraftCaptureSnapshotSchema>;
export type DraftCaptureHistory=z.infer<typeof DraftCaptureHistorySchema>;
export type DraftCaptureIdentity=z.infer<typeof DraftCaptureIdentitySchema>;
export const DraftCaptureSavedSchema=z.object({id:z.uuid(),sha256:Hash,recordedAt:CaptureTimeSchema,
  snapshot:DraftCaptureSnapshotSchema}).strict();
