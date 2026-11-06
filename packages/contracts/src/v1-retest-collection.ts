import {z} from 'zod';
import {HistoricalCollectionConfigSchema,HistoricalStoredRecordSchema} from './v1-historical-collection.js';
const Time=z.iso.datetime({precision:3}),Sha=z.string().regex(/^[a-f0-9]{64}$/);
const File=z.object({path:z.string().min(1).max(1024),sha256:Sha}).strict();
const Key=z.string().regex(/^(?:map-[1-9]\d{0,18}|history-\d{3})$/);
export const RetestCollectionConfigSchema=z.object({schemaVersion:z.literal(2),protocolInputs:File,protocol:File,
 cache:File,canonicalHistory:File,historyPolicy:HistoricalCollectionConfigSchema.shape.historyPolicy,
 maxRequestsPerRun:z.literal(50),maxHistoryHttpAttempts:z.literal(3),syntheticOnly:z.boolean()}).strict();
export const RetestAdmissionSchema=z.object({schemaVersion:z.literal(2),configSha256:Sha,key:Key,
 ordinal:z.number().int().min(1).max(3),runId:z.uuid(),admittedAt:Time,
 endpoint:z.string().min(1).max(20000),fingerprint:Sha}).strict();
export const RetestOutcomeSchema=z.object({schemaVersion:z.literal(2),configSha256:Sha,key:Key,
 ordinal:z.number().int().min(1).max(3),admissionFingerprint:Sha,completedAt:Time,
 status:z.enum(['captured','failed','interrupted','late_response']),code:z.string().regex(/^[a-z_]+$/).nullable(),
 httpStatus:z.number().int().min(100).max(599).nullable(),retryAfterMs:z.number().nonnegative().finite().nullable(),
 notBeforeAt:Time.nullable(),record:HistoricalStoredRecordSchema.nullable(),fingerprint:Sha}).strict();
