import {z} from 'zod';
const Time=z.iso.datetime({precision:3}),Sha=z.string().regex(/^[a-f0-9]{64}$/);
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n);
const File=z.object({path:z.string().min(1).max(1024),sha256:Sha}).strict();
export const HistoricalCollectionConfigSchema=z.object({schemaVersion:z.literal(1),
 protocolInputs:File,protocol:File,discoveryCaptures:File,discoveryReview:File,cache:File,canonicalHistory:File,
 historyPolicy:z.object({windowDays:z.literal(730),maxMapsPerAccount:z.literal(10),
  selection:z.literal('latest_completed_pro_per_account_before_first_event_window')}).strict(),
 maxRequestsPerRun:z.number().int().min(1).max(50),syntheticOnly:z.boolean()
}).strict();
export const HistoricalCacheSchema=z.object({schemaVersion:z.literal(1),matches:z.array(File.extend({matchId:Id})).max(5000)
 .refine(rows=>new Set(rows.map(r=>r.matchId)).size===rows.length)}).strict();
export const HistoricalObservationSchema=z.object({source:z.object({provider:z.literal('opendota'),
 endpoint:z.string().min(1).max(20000),fetchedAt:Time,knownAt:z.null(),payloadSha256:Sha,
 adapterVersion:z.string().min(1).max(120)}).strip(),rawBody:z.string().min(2).max(16777216)}).strip();
const RawId=z.union([Id,z.number().int().positive().safe().transform(String)]);
const OptionalId=z.union([RawId,z.literal(0),z.literal('0'),z.null()]).optional().transform(v=>v===0||v==='0'||v===undefined?null:v);
const Account=OptionalId.refine(v=>v===null||BigInt(v)<4294967295n);
const N=z.number().int().nonnegative().safe().nullish().transform(v=>v??null);
// V1 consumes no hero/role/patch/telemetry fields. Invalid unused fields cannot veto it.
export const HistoricalMapSchema=z.object({match_id:RawId,start_time:N,duration:N,radiant_win:z.boolean().nullish().transform(v=>v??null),
 leagueid:OptionalId,series_id:OptionalId,radiant_team_id:OptionalId,dire_team_id:OptionalId,lobby_type:N,
 players:z.array(z.object({account_id:Account,player_slot:N})).max(20).nullish().transform(v=>v??[])});
export const HistoricalStoredRecordSchema=z.object({schemaVersion:z.literal(1),configSha256:Sha,key:z.string().regex(/^(?:map-[1-9]\d{0,18}|history-\d{3})$/),
 storedAt:Time,origin:z.enum(['live','cache']),cacheRef:File.nullable(),observation:HistoricalObservationSchema,fingerprint:Sha}).strict();
export const HistoricalFailureSchema=z.object({key:HistoricalStoredRecordSchema.shape.key,at:Time,
 code:z.string().regex(/^[a-z_]+$/),httpStatus:z.number().int().min(100).max(599).nullable().optional(),
 retryAfterMs:z.number().nonnegative().finite().nullable()}).strict();
