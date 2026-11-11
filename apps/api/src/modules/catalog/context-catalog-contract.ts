import {z} from 'zod';
import {CatalogIdSchema} from '@dota/contracts';
export const ContextKindSchema=z.enum(['patches','leagues']);
export type ContextKind=z.infer<typeof ContextKindSchema>;
export const ContextCatalogQuerySchema=z.object({kind:ContextKindSchema,query:z.string().trim().max(80).default(''),
 offset:z.coerce.number().int().min(0).max(10000).default(0),id:CatalogIdSchema.optional()}).strict()
 .refine(q=>!q.id||!q.query&&q.offset===0,{message:'Exact ID cannot be combined with search'});
export type ContextCatalogQuery=z.infer<typeof ContextCatalogQuerySchema>;
export const ContextCatalogSchema=z.object({kind:ContextKindSchema,source:z.literal('local_catalogue'),readAt:z.iso.datetime({precision:3}),
 items:z.array(z.object({id:CatalogIdSchema,name:z.string()}).strict()).max(20),hasMore:z.boolean()}).strict();
