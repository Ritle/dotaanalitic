import {z} from 'zod';
import {UpcomingMatchSchema,UpcomingScheduleResponseSchema,ScheduleSourceSchema} from '@dota/contracts';
export const LIVE_ENDPOINT='/dota2/matches/running?sort=scheduled_at,id&page=1&per_page=20';
export const LiveMatchSchema=UpcomingMatchSchema.extend({beganAt:z.iso.datetime({precision:3}).nullable(),
 seriesScore:z.array(z.object({providerTeamId:z.string().regex(/^[1-9]\d{0,18}$/),wins:z.number().int().min(0).max(100)}).strict()).length(2).nullable()}).strict().superRefine((m,ctx)=>{
 if(m.seriesScore&&(m.opponents.length!==2||new Set(m.seriesScore.map(s=>s.providerTeamId)).size!==2||m.seriesScore.some((s,i)=>s.providerTeamId!==m.opponents[i]?.providerTeamId)))
  ctx.addIssue({code:'custom',message:'Score teams must match opponent order'});
});
export type LiveMatch=z.infer<typeof LiveMatchSchema>;
export const LiveSnapshotSchema=z.object({data:z.array(LiveMatchSchema).max(20),
 source:ScheduleSourceSchema.extend({endpoint:z.literal(LIVE_ENDPOINT),adapterVersion:z.literal('pandascore-running-v1')}).strict()}).strict();
export const LiveResponseSchema=UpcomingScheduleResponseSchema.extend({snapshot:LiveSnapshotSchema.nullable()}).strict();
export type LiveResponse=z.infer<typeof LiveResponseSchema>;
