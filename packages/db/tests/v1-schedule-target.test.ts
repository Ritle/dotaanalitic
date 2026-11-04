import {expect,it} from 'vitest';
import {V1ScheduleTargetRequestSchema,type V1ScheduleObservation} from '@dota/contracts';
import {scheduleTargetReasons,validateScheduleMapping} from '../src/v1-schedule-target.js';
const o:V1ScheduleObservation={id:'1',snapshotSha256:'a'.repeat(64),sourcePayloadSha256:'b'.repeat(64),fetchedAt:'2026-01-01T00:00:00.000Z',
  recordedAt:'2026-01-01T00:00:00.000001Z',knownAt:null,endpoint:'synthetic',adapterVersion:'synthetic',
  match:{providerMatchId:'9007199254742999',name:'Synthetic',status:'not_started',scheduledAt:'2026-01-02T00:00:00.000Z',
    tournament:{providerTournamentId:'7',name:null},league:{providerLeagueId:'8',name:null},eventSeries:null,seriesBestOf:3,
    opponents:[{providerTeamId:'74',name:'Same name'},{providerTeamId:'75',name:'Same name'}]}};
const req=()=>V1ScheduleTargetRequestSchema.parse({requestId:'00000000-0000-4000-8000-000000000001',providerMatchId:o.match.providerMatchId,
  observationId:o.id,observationSha256:o.snapshotSha256,expectedRevision:0,mapNumber:1,providerTeamAId:'75',providerTeamBId:'74',teamAId:'11',teamBId:'22',leagueId:null,
  reviewSourceUrl:'https://example.test/synthetic',reason:'Synthetic explicit team mapping'});
it('requires strictly future schedule and complete distinct opponents without turning BO3 into a map result',()=>{
  expect(scheduleTargetReasons(o,'2026-01-01T23:59:59.999999Z')).toEqual([]);
  expect(scheduleTargetReasons(o,'2026-01-02T00:00:00.000000Z')).toContain('SCHEDULE_ALREADY_STARTED');
  for(const patch of [{scheduledAt:null},{status:'running'},{opponents:[]},{opponents:[o.match.opponents[0]!,o.match.opponents[0]!]}])
    expect(scheduleTargetReasons({...o,match:{...o.match,...patch}},'2026-01-01T00:00:01.000000Z').length).toBeGreaterThan(0);
});
it('accepts explicit A/B swaps by provider ID, never by equal nicknames or numeric ID coincidence',()=>{
  expect(()=>validateScheduleMapping(o,req())).not.toThrow();
  expect(()=>validateScheduleMapping(o,{...req(),providerTeamAId:'11'})).toThrow('schedule_target_mapping');
  expect(()=>validateScheduleMapping(o,{...req(),providerMatchId:'7'})).toThrow('schedule_target_mapping');
});
it('rejects forged winner, probability, timestamps, automatic source bindings and duplicate teams',()=>{
  for(const extra of [{winner:'A'},{probability:0.8},{selectedAt:'2025-01-01T00:00:00.000Z'},{providerSeriesId:'9007199254742999'},
    {mapNumber:2},{teamAId:'22'},{providerTeamAId:'74'}])expect(V1ScheduleTargetRequestSchema.safeParse({...req(),...extra}).success).toBe(false);
});
