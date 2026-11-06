import {z} from 'zod';
import {UpcomingMatchSchema,ScheduleSourceSchema,UpcomingScheduleResponseSchema} from './upcoming.js';

export const SCHEDULE_PAGE_LIMIT=50;
export const SchedulePageNumberSchema=z.number().int().min(1).max(SCHEDULE_PAGE_LIMIT);
export const SchedulePageQuerySchema=z.object({page:z.string().regex(/^[1-9]\d?$/).transform(Number)
  .pipe(SchedulePageNumberSchema).optional().default(1)}).strict();
export const schedulePageEndpoint=(page:number)=>`/dota2/matches/upcoming?sort=scheduled_at,id&page=${SchedulePageNumberSchema.parse(page)}&per_page=20`;
export const SchedulePageCacheDataSchema=z.object({data:z.array(UpcomingMatchSchema).max(20),
  source:ScheduleSourceSchema.extend({endpoint:z.string().regex(/^\/dota2\/matches\/upcoming\?sort=scheduled_at,id&page=(?:[1-9]|[1-4]\d|50)&per_page=20$/)})
}).strict().refine(value=>new Set(value.data.map(m=>m.providerMatchId)).size===value.data.length,'duplicate_match');
export const SchedulePageResponseSchema=UpcomingScheduleResponseSchema.omit({snapshot:true})
  .extend({snapshot:SchedulePageCacheDataSchema.nullable()}).strict();
export type SchedulePageResponse=z.infer<typeof SchedulePageResponseSchema>;
