import {z} from 'zod';
import {PandaUpcomingSchema,PandaIdSchema} from '@dota/ingestion';
import {LiveMatchSchema} from './contract.js';
const Extra=z.object({id:PandaIdSchema,began_at:z.iso.datetime({offset:true}).nullable().optional(),
 results:z.array(z.object({team_id:PandaIdSchema,score:z.number().int().min(0).max(100).nullable()})).max(2).nullable().optional()});
// Validate provider fields independently; match result order is never a team side.
export const PandaLiveSchema=z.array(z.unknown()).max(20).transform((input,ctx)=>{
 const base=PandaUpcomingSchema.safeParse(input),extra=z.array(Extra).max(20).safeParse(input);
 if(!base.success||!extra.success){ctx.addIssue({code:'custom',message:'Invalid running-match fields'});return z.NEVER;}
 return base.data.map(m=>{
  const e=extra.data.find(r=>r.id===m.providerMatchId)!;
  const results=e.results??[],ids=m.opponents.map(o=>o.providerTeamId);
  const valid=ids.length===2&&results.length===2&&new Set(results.map(r=>r.team_id)).size===2&&results.every(r=>ids.includes(r.team_id)&&r.score!==null);
  return LiveMatchSchema.parse({...m,beganAt:e.began_at?new Date(e.began_at).toISOString():null,
   seriesScore:valid?m.opponents.map(o=>({providerTeamId:o.providerTeamId,wins:results.find(r=>r.team_id===o.providerTeamId)!.score})):null});
 });
});
