import { z } from 'zod';
import { ContextFactSchema } from './temporal.js';
import { DatasetBuildRequestSchema } from './dataset-build.js';
const splits=['train','calibration','validation','test'] as const;
const Id=z.string().regex(/^[1-9]\d*$/).refine(v=>BigInt(v)<=9223372036854775807n);
const Time=z.iso.datetime({precision:3});
const SqlTime=z.iso.datetime({offset:true}).refine(v=>{
  const fraction=/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(v)?.[1]??'';
  return !/[1-9]/.test(fraction.slice(3));
},{message:'Sub-millisecond SQL timestamps must not be rounded'}).transform(v=>new Date(v).toISOString());
export const DatasetAuditDigestSchema=z.string().regex(/^[a-f0-9]{64}$/);
const Digest=DatasetAuditDigestSchema;
const Count=z.number().int().nonnegative();
const Fact=z.union([ContextFactSchema,z.object({field:z.literal('patch'),value:Id}).strict()]);
const Proof=z.looseObject({knownAt:Time.nullable(),eventAt:Time.nullable(),fetchedAt:Time});
const Snapshot=z.looseObject({schemaVersion:z.literal('prepared-context-v1'),stage:z.enum(['pre_match','post_draft']),
  matchId:Id,cutoffAt:Time,teamAId:Id,teamBId:Id,teamASide:z.enum(['radiant','dire']),facts:z.array(Fact),
  contextProofs:z.array(Proof),patchProofs:z.array(Proof),identityProofs:z.array(Proof)});
const SeriesProof=z.looseObject({id:z.uuid(),provider:z.string().min(1),providerSeriesId:Id,teamAId:Id,teamBId:Id});
const Member=z.looseObject({matchId:Id,seriesId:z.uuid().nullable(),startedAt:Time,
  providerSeriesKey:z.string().nullable().optional(),seriesConflict:z.boolean().optional(),seriesOrganizationsKnown:z.boolean().optional()});
const Alias=z.looseObject({seriesId:z.uuid(),provider:z.string().nullable(),providerSeriesId:z.string().nullable(),
  teamAId:Id.nullable(),teamBId:Id.nullable(),providerSeriesKey:z.string().nullable(),seriesConflict:z.boolean(),seriesOrganizationsKnown:z.boolean()});
const Input=z.looseObject({matchId:Id,inputSnapshot:Snapshot,inputSnapshotHash:Digest,seriesProof:SeriesProof,
  sourceEvidence:z.looseObject({receiptId:Id,payloadSha256:Digest,receiptFetchedAt:Time}),dataRevision:z.string(),
  quality:z.array(z.json()),qualityFingerprint:Digest});
const Assessment=z.looseObject({matchId:Id,reasons:z.array(z.string()),split:z.enum(splits).nullable(),patchId:Id.nullable()});
const Source=z.looseObject({policyVersion:z.string(),request:DatasetBuildRequestSchema,
  cohort:z.literal('strict_verified_asof'),trainingReady:z.literal(false),deployable:z.literal(false),
  syntheticOnly:z.boolean(),featureState:z.literal('not_built'),historyState:z.literal('not_built'),
  seriesInventory:z.array(Member).max(10000),seriesAliases:z.array(Alias).max(10000).optional(),
  inputs:z.array(Input).max(5000),summary:z.looseObject({candidates:Count,eligible:Count,excluded:Count,
    bySplit:z.record(z.string(),Count),byPatch:z.record(z.string(),Count),assessments:z.array(Assessment).max(5000)})});
const MapRow=z.looseObject({match_id:Id,split:z.enum(splits),team_a_id:Id,team_b_id:Id,cutoff_at:SqlTime,
  input_features:z.record(z.string(),z.json()),input_hash:Digest,team_a_won:z.boolean(),label_source:z.string(),
  label_verified_at:SqlTime,source_evidence:z.looseObject({receiptId:Id,payloadSha256:Digest,receiptFetchedAt:Time}),
  outcome_receipt_id:Id,match_data_revision:z.string(),series_id_snapshot:z.uuid().nullable()});
export const FrozenDatasetAuditContentSchema=z.looseObject({format:z.literal('pg-jsonb-dataset-v1'),manifest:z.looseObject({
  stage:z.enum(['pre_match','post_draft']),feature_schema_version:z.literal('prepared-context-v1'),
  label_policy_version:z.literal('verified-map-v1'),cutoff_policy_version:z.string(),data_revision:Digest,
  split_policy:z.looseObject({version:z.string(),fromAt:Time,trainUntil:Time,calibrationUntil:Time,validationUntil:Time,toAt:Time}),
  source_manifest:Source}),maps:z.array(MapRow).max(5000)});
export const FrozenDatasetAuditEnvelopeSchema=z.looseObject({format:z.string(),manifest:z.looseObject({feature_schema_version:z.string(),source_manifest:z.json().optional()})});
