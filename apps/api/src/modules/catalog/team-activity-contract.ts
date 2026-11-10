import {z} from 'zod';
import {CatalogIdSchema,CatalogQuerySchema,CatalogItemSchema,CatalogListSchema} from '@dota/contracts';
// Pure presentation contract shared with Vue, independent of the frozen prediction contract.
export const ActivityStatusSchema=z.enum(['active','inactive','unknown']);
export const ActivityViewSchema=z.enum(['current','archived','all']);
const SourceUrl=z.string().trim().max(2000).url().refine(s=>{try{const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}});
const Fields={status:ActivityStatusSchema,basis:z.enum(['source','owner']),sourceUrl:SourceUrl.nullable(),note:z.string().trim().min(3).max(1000),checkedAt:z.iso.datetime(),effectiveAt:z.iso.datetime().nullable()};
export const ActivityWriteSchema=z.object({requestId:z.uuid(),expectedRevision:z.number().int().min(0).max(2147483646),...Fields}).strict().superRefine((v,c)=>{
 if((v.basis==='source')!==Boolean(v.sourceUrl))c.addIssue({code:'custom',message:'Source must match review basis'});
 if(v.effectiveAt&&Date.parse(v.effectiveAt)>Date.parse(v.checkedAt))c.addIssue({code:'custom',message:'Effective time after review'});
});
export const ActivityRecordSchema=z.object({revision:z.number().int().positive(),...Fields,recordedAt:z.iso.datetime()}).strict();
export const ActivityReportSchema=z.object({teamId:CatalogIdSchema,current:ActivityRecordSchema.nullable(),history:z.array(ActivityRecordSchema).max(20),hasMore:z.boolean(),computedAt:z.iso.datetime()}).strict();
export const TeamDirectoryQuerySchema=CatalogQuerySchema.extend({activityView:ActivityViewSchema.default('current')}).strict();
export const TeamDirectorySchema=CatalogListSchema.extend({kind:z.literal('teams'),activityView:ActivityViewSchema,items:z.array(CatalogItemSchema.extend({activityStatus:ActivityStatusSchema}).strict())}).strict();
export type ActivityWrite=z.infer<typeof ActivityWriteSchema>;
export type ActivityRecord=z.infer<typeof ActivityRecordSchema>;
export type TeamDirectoryQuery=z.infer<typeof TeamDirectoryQuerySchema>;
