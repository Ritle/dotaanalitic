import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
import {V1LifecycleRequestSchema} from './v1-target-lifecycle.js';
const Id=z.uuid().transform(v=>v.toLowerCase()),Sha=z.string().regex(/^[a-f0-9]{64}$/);
export const V1ScheduledLifecycleTargetSchema=z.object({provider:z.literal('pandascore'),providerMatchId:CatalogIdSchema,mapNumber:z.literal(1)}).strict();
export const V1ScheduledLifecycleRequestSchema=V1LifecycleRequestSchema.omit({predictionRequestId:true}).extend({targetRequestId:Id});
export const V1ScheduledLifecycleCreateSchema=V1ScheduledLifecycleRequestSchema.omit({targetRequestId:true}).extend({confirmedByOwner:z.literal(true)});
export const V1ScheduledLifecycleEventSchema=z.object({format:z.literal('v1-scheduled-lifecycle-v1'),ownerId:Id,target:V1ScheduledLifecycleTargetSchema,
  revision:z.number().int().positive(),previousSha256:Sha.nullable(),request:V1ScheduledLifecycleRequestSchema,
  source:z.literal('owner_reported'),recordedAt:z.iso.datetime({precision:6})}).strict();
export const V1ScheduledLifecycleSavedSchema=z.object({event:V1ScheduledLifecycleEventSchema,sha256:Sha}).strict();
export const V1ScheduledLifecycleViewSchema=V1ScheduledLifecycleSavedSchema.extend({event:V1ScheduledLifecycleEventSchema.omit({ownerId:true})});
export const V1ScheduledLifecycleHistorySchema=z.object({items:z.array(V1ScheduledLifecycleViewSchema).max(20),nextBeforeRevision:z.number().int().positive().nullable(),
  verifiedBindingExists:z.boolean()}).strict();
export type V1ScheduledLifecycleRequest=z.infer<typeof V1ScheduledLifecycleRequestSchema>;
export type V1ScheduledLifecycleSaved=z.infer<typeof V1ScheduledLifecycleSavedSchema>;
