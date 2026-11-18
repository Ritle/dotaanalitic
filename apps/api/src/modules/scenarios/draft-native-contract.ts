import {z} from 'zod';
import {CatalogIdSchema} from '@dota/contracts';
import {CaptureTimeSchema} from './draft-capture-contract.js';
const Hash=z.string().regex(/^[a-f0-9]{64}$/);
export const DraftNativeRequestSchema=z.object({requestId:z.uuid(),matchId:CatalogIdSchema}).strict();
export const DraftNativeResultSchema=z.object({
  format:z.literal('owner-draft-native-binding-v1'),captureId:z.uuid(),captureSha256:Hash,matchId:CatalogIdSchema,
  inspectedAt:CaptureTimeSchema,status:z.enum(['verified','unavailable']),reasons:z.array(z.string()),
  teamASide:z.enum(['radiant','dire']).nullable(),dataRevision:z.string().nullable(),receiptId:CatalogIdSchema.nullable(),
  receiptPayloadSha256:Hash.nullable(),providerStartedAtUs:z.string().nullable(),
  temporalStatus:z.enum(['before_provider_start_semantics_unverified','not_before_provider_start','unavailable']),
  selectionSource:z.literal('owner_native_map_id'),scheduleMappingVerified:z.literal(false),mapOrdinalVerified:z.literal(false),
  prestartVerified:z.literal(false),primaryEligible:z.literal(false),deployable:z.literal(false)
}).strict();
export const DraftNativeSavedSchema=z.object({id:z.uuid(),recordedAt:CaptureTimeSchema,sha256:Hash,result:DraftNativeResultSchema}).strict();
export const DraftNativeStateSchema=z.object({binding:DraftNativeSavedSchema.nullable(),latestAttempt:DraftNativeSavedSchema.nullable()}).strict();
