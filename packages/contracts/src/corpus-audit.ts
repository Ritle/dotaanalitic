import { z } from 'zod';
import { DatasetBuildRequestSchema } from './dataset-build.js';
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(s=>BigInt(s)<=9223372036854775807n);
const Time=z.iso.datetime({precision:3});
export const CorpusShaSchema=z.string().regex(/^[a-f0-9]{64}$/);
const Evidence=z.object({endpoint:z.string().min(1).max(512),fetched_at:Time,payload_sha256:CorpusShaSchema,
  adapter_version:z.string().min(1).max(200)});
const RawMap=z.object({match_id:Id,start_time:z.number().int().positive().max(253402300799).nullable(),
  duration:z.number().int().nonnegative().nullable(),radiant_win:z.boolean().nullable(),radiant_team_id:Id.nullable(),
  dire_team_id:Id.nullable(),leagueid:Id.nullable(),series_id:Id.nullable(),series_type:z.number().int().nullable()});
export const CorpusDiscoverySchema=z.object({schema_version:z.literal(1),mode:z.literal('live_opendota'),generated_at:Time,
  selection_catalog:z.object({source_evidence:Evidence}),cohorts:z.array(z.object({league_id:Id,
    name:z.string(),tier:z.string().nullable(),endpoint_completeness:z.literal('unknown'),
    series_membership_completeness:z.literal('unknown'),source_evidence:Evidence,matches:z.array(RawMap).max(20000)})).max(30),
  errors:z.array(z.unknown()).max(200)});
export const CorpusDetailSchema=z.object({schema_version:z.literal(3),mode:z.literal('live_opendota'),generated_at:Time,
  status:z.enum(['complete','partial','blocked']),source_evidence:z.array(Evidence).max(20),
  observations:z.array(z.object({match_id:Id,started_at:Time.nullable(),league_id:Id.nullable(),
    provider_patch_id:z.union([z.number().int().positive(),Id]).nullable(),
    flags:z.record(z.string(),z.boolean().nullable()),source_evidence:Evidence.nullable()})).max(50)});
export const CorpusAuditConfigSchema=z.object({
  schemaVersion:z.literal(1),request:DatasetBuildRequestSchema,
  captures:z.array(z.object({kind:z.enum(['discovery','details']),path:z.string().min(1).max(2048),sha256:CorpusShaSchema}).strict()).min(1).max(30)
}).strict();
