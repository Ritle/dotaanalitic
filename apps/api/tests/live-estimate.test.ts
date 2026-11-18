import {test,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {LiveEstimateRequestSchema,liveEstimateScenario} from '../src/modules/live/estimate-contract';
import {runtimeFixture} from '../../../packages/db/tests/v1-runtime-fixtures';
const request=()=>({requestId:randomUUID(),acknowledgedConditional:true as const,providerTeamAId:'1',providerTeamBId:'2',teamAId:'11',teamBId:'22',lineupA:runtimeFixture().input.lineupA,lineupB:runtimeFixture().input.lineupB});
test('live estimate requires explicit acknowledgement and ten distinct identified players',()=>{
 expect(LiveEstimateRequestSchema.safeParse({...request(),acknowledgedConditional:false}).success).toBe(false);
 const r=request();r.lineupB[0]!.playerId=r.lineupA[0]!.playerId;expect(LiveEstimateRequestSchema.safeParse(r).success).toBe(false);
 expect(LiveEstimateRequestSchema.safeParse({...request(),teamBId:'11'}).success).toBe(false);
 expect(LiveEstimateRequestSchema.safeParse({...request(),cutoffAt:'2099-01-01T00:00:00.000Z'}).success).toBe(false);
});
test('conditional scenario never fabricates future start, map number, score or side',()=>{
 const scenario=liveEstimateScenario(request(),'Synthetic conditional comparison','2026-11-13T15:00:00.000Z','77');
 expect(scenario.scheduledAt).toBeNull();expect(scenario.context).toMatchObject({seriesId:null,mapNumber:null,teamASeriesWinsBefore:null,teamBSeriesWinsBefore:null,radiantSlot:null,firstPickSlot:null});
 expect(scenario.cutoffAt).toBe('2026-11-13T15:00:00.000Z');expect(scenario.draft).toBeUndefined();
});
