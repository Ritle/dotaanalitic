import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
const Id=z.uuid().transform(v=>v.toLowerCase()), Sha=z.string().regex(/^[a-f0-9]{64}$/);
export const V1LifecycleTargetSchema=z.object({provider:z.literal('opendota'),providerSeriesId:CatalogIdSchema,mapNumber:z.literal(1)}).strict();
export const V1LifecycleRequestSchema=z.object({requestId:Id,predictionRequestId:Id,expectedRevision:z.number().int().min(0).max(2147483646),
  action:z.enum(['cancelled','reopened']),eventAt:z.iso.datetime({precision:3}).nullable(),
  sourceUrl:z.url().refine(v=>['https:','http:'].includes(new URL(v).protocol)).max(2048),reason:z.string().trim().min(10).max(1000)}).strict();
export const V1LifecycleEventSchema=z.object({format:z.literal('v1-target-lifecycle-v1'),ownerId:Id,target:V1LifecycleTargetSchema,
  revision:z.number().int().positive(),previousSha256:Sha.nullable(),request:V1LifecycleRequestSchema,
  source:z.literal('owner_reported'),recordedAt:z.iso.datetime({precision:6})}).strict();
export const V1LifecycleSavedSchema=z.object({event:V1LifecycleEventSchema,sha256:Sha}).strict();
export type V1LifecycleSaved=z.infer<typeof V1LifecycleSavedSchema>;
