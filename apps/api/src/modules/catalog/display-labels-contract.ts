import {z} from 'zod';
import {CatalogIdSchema} from '@dota/contracts';
const ids=(max:number)=>z.string().max(max*20).default('').transform(value=>value?value.split(','):[]).pipe(z.array(CatalogIdSchema).max(max));
// One scenario at a time: two organizations, actual 5+5 and optional baseline 5+5.
export const DisplayLabelsQuerySchema=z.object({teams:ids(2),players:ids(20)}).strict();
export type DisplayLabelsQuery=z.infer<typeof DisplayLabelsQuerySchema>;
const item=z.object({id:CatalogIdSchema,name:z.string()}).strict();
export const DisplayLabelsSchema=z.object({source:z.literal('local_catalogue'),readAt:z.iso.datetime({precision:3}),
 teams:z.array(item).max(2),players:z.array(item).max(20)}).strict();
