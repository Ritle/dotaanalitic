import {V1ScheduleTargetSavedSchema,V1ScheduledPredictionViewSchema} from '../../packages/contracts/src/index.js';
import {predictionViewFixture} from './prediction-view.js';
/** Synthetic display/contract fixture only, never persisted as provider evidence. */
export function syntheticScheduledTarget(){
  const clock='2026-11-02T12:00:00.123456Z';
  return V1ScheduleTargetSavedSchema.parse({sha256:'a'.repeat(64),record:{format:'v1-schedule-target-v1',provider:'pandascore',revision:1,previousSha256:null,
    selectedAt:clock,mappingBasis:'owner_reviewed',teamAName:'Synthetic A',teamBName:'Synthetic B',leagueName:'Synthetic Event',mapBinding:'pending',probability:null,warnings:[],omittingLaterPages:0,
    request:{requestId:'33333333-3333-4333-8333-333333333333',providerMatchId:'9007199254742999',observationId:'1',observationSha256:'b'.repeat(64),expectedRevision:0,mapNumber:1,
      providerTeamAId:'74',providerTeamBId:'75',teamAId:'11',teamBId:'22',leagueId:'77',reviewSourceUrl:'https://example.test/synthetic-review',reason:'Synthetic reviewed organization mapping'},
    observation:{id:'1',snapshotSha256:'b'.repeat(64),sourcePayloadSha256:'c'.repeat(64),fetchedAt:'2026-11-02T12:00:00.123Z',recordedAt:clock,knownAt:null,
      endpoint:'/dota2/matches/upcoming?sort=scheduled_at,id&page=1&per_page=20',adapterVersion:'synthetic',match:{providerMatchId:'9007199254742999',name:'Synthetic Target Match',status:'not_started',
        scheduledAt:'2099-01-02T00:00:00.000Z',tournament:{providerTournamentId:'71',name:'Synthetic Stage'},league:{providerLeagueId:'72',name:'Synthetic Event'},eventSeries:null,seriesBestOf:3,
        opponents:[{providerTeamId:'74',name:'Synthetic A'},{providerTeamId:'75',name:'Synthetic B'}]}}}});
}
export function syntheticScheduledView(){
  const target=syntheticScheduledTarget(),v=predictionViewFixture();
  return V1ScheduledPredictionViewSchema.parse({...v,purpose:'real_map',scenario:{...v.scenario,input:{...v.scenario.input,context:{...v.scenario.input.context,mapNumber:1}}},
    target:{provider:'pandascore',bindingVersion:1,providerMatchId:target.record.request.providerMatchId,mapNumber:1,targetRequestId:target.record.request.requestId,targetSha256:target.sha256}});
}
