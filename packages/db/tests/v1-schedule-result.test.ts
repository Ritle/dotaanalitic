import {expect,it} from 'vitest';
import {V1ScheduleResultRequestSchema} from '@dota/contracts';
it('requires explicit reviewed identifiers and rejects outcomes, clocks, guesses and unsafe URLs',()=>{
  const r={requestId:'11111111-1111-4111-8111-111111111111',predictionRequestId:'22222222-2222-4222-8222-222222222222',
    targetSha256:'a'.repeat(64),matchId:'9007199254742999',providerSeriesId:'321',sourceUrl:'https://example.test/review',rationale:'Synthetic reviewed cross-provider association'};
  expect(V1ScheduleResultRequestSchema.parse(r)).toEqual(r);
  for(const patch of [{matchId:9007199254742999},{providerSeriesId:'0'},{sourceUrl:'javascript:alert(1)'},{rationale:'guess'},
    {teamAWon:true},{reviewedAt:'2000-01-01T00:00:00Z'},{targetSha256:'bad'}])expect(V1ScheduleResultRequestSchema.safeParse({...r,...patch}).success).toBe(false);
});
