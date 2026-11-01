import {z} from 'zod';
import {CatalogIdSchema} from './catalog.js';
const Time=z.iso.datetime({precision:3}),N=z.number().int().min(0).max(10);
export const HistoryRunSchema=z.object({id:z.uuid(),teamId:CatalogIdSchema,status:z.enum(['queued','running','completed','partial','error']),
  createdAt:Time,updatedAt:Time,startedAt:Time.nullable(),finishedAt:Time.nullable(),sourceFetchedAt:Time.nullable(),
  attempt:z.number().int().min(0).max(3),selected:N.nullable(),processed:N,accepted:N,duplicates:N,excluded:N,sourceErrors:N,conflicts:N,
  errorCode:z.enum(['source_unavailable','import_failed','worker_unavailable']).nullable()}).strict();
export const HistoryRefreshResponseSchema=z.object({teamId:CatalogIdSchema,available:z.boolean(),retryAt:Time.nullable(),
  run:HistoryRunSchema.nullable(),message:z.string().max(400)}).strict();
export type HistoryRun=z.infer<typeof HistoryRunSchema>;
export type HistoryRefreshResponse=z.infer<typeof HistoryRefreshResponseSchema>;
