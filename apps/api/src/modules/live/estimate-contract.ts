import {z} from 'zod';
import {ScenarioInputSchema,ScenarioSnapshotSchema,V1PredictionCoverageSchema,V1PredictionFeatureViewSchema} from '@dota/contracts';
import {QuickForecastRequestSchema} from '../upcoming/quick-forecast-contract.js';
import {LiveMatchSchema} from './contract.js';
export const LiveEstimateRequestSchema=QuickForecastRequestSchema.extend({acknowledgedConditional:z.literal(true)}).superRefine((r,ctx)=>{
 if(r.teamAId===r.teamBId||r.providerTeamAId===r.providerTeamBId||new Set([...r.lineupA,...r.lineupB].map(p=>p.playerId)).size!==10)
  ctx.addIssue({code:'custom',message:'Two teams and ten distinct players required'});
});
export type LiveEstimateRequest=z.infer<typeof LiveEstimateRequestSchema>;
export const LiveEstimateViewSchema=z.object({requestId:z.uuid(),providerMatchId:z.string(),purpose:z.literal('live_lineup_comparison'),
 status:z.enum(['done','unavailable']),teamAWinProbability:z.number().min(0).max(1).nullable(),reasons:z.array(z.string()),
 createdAt:z.iso.datetime(),cutoffAt:z.iso.datetime(),snapshotSha256:z.string().regex(/^[a-f0-9]{64}$/),
 scenario:ScenarioSnapshotSchema,match:LiveMatchSchema,modelId:z.uuid().nullable(),coverage:V1PredictionCoverageSchema.nullable(),
 players:V1PredictionFeatureViewSchema.pick({teamA:true,teamB:true}).nullable(),
 sourceFetchedAt:z.iso.datetime(),historyFromAt:z.iso.datetime(),eventName:z.string()
}).strict().refine(r=>r.status==='done'?r.teamAWinProbability!==null&&r.reasons.length===0&&r.modelId!==null:r.teamAWinProbability===null&&r.reasons.length>0);
export type LiveEstimateView=z.infer<typeof LiveEstimateViewSchema>;
export const LiveEstimateHistorySchema=z.object({items:z.array(LiveEstimateViewSchema).max(20)}).strict();
export const liveEstimateScenario=(request:LiveEstimateRequest,title:string,at:string,leagueId:string|null)=>ScenarioInputSchema.parse({
 title:title.slice(0,120),teamAId:request.teamAId,teamBId:request.teamBId,lineupA:request.lineupA,lineupB:request.lineupB,
 cutoffAt:at,scheduledAt:null,confirmedByOwner:true,expectedLineupA:null,expectedLineupB:null,
 context:{leagueId,seriesId:null,mapNumber:null,teamASeriesWinsBefore:null,teamBSeriesWinsBefore:null,radiantSlot:null,firstPickSlot:null,venueKind:null,tournamentStage:null}
});
