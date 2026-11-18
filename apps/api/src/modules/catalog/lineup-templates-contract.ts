import {z} from 'zod';
import {CatalogIdSchema,OwnerLoginSchema} from '@dota/contracts';
export const OwnerPermissionErrorSchema=z.object({error:z.object({code:z.literal('OWNER_REQUIRED')})});
export const AccountAccessSchema=z.object({role:z.enum(['owner','user']),canManageLineups:z.boolean()}).strict();
export const TemplateLineupSchema=z.array(z.object({playerId:CatalogIdSchema,rolePos:z.number().int().min(1).max(5)}).strict()).length(5)
 .refine(rows=>new Set(rows.map(p=>p.playerId)).size===5&&new Set(rows.map(p=>p.rolePos)).size===5,'Five distinct players and roles required');
export const LineupTemplateWriteSchema=z.object({requestId:z.uuid().transform(id=>id.toLowerCase()),expectedRevision:z.number().int().min(0).max(2147483646),confirmedByOwner:z.literal(true),lineup:TemplateLineupSchema}).strict();
export const LineupTemplateSchema=z.object({teamId:CatalogIdSchema,revision:z.number().int().positive(),lineup:TemplateLineupSchema,
 confirmedBy:z.object({id:z.uuid(),login:OwnerLoginSchema}),confirmedAt:z.iso.datetime()}).strict();
export const LineupTemplateReportSchema=z.object({teamId:CatalogIdSchema,current:LineupTemplateSchema.nullable(),history:z.array(LineupTemplateSchema).max(20),hasMore:z.boolean()}).strict();
export type LineupTemplateWrite=z.infer<typeof LineupTemplateWriteSchema>;
export type LineupTemplate=z.infer<typeof LineupTemplateSchema>;
