import {expect,it} from 'vitest';
import {V1ScheduledBindingCreateSchema,V1ScheduledOutcomeRefreshSchema} from '@dota/contracts';
import {scheduledOutcomeView} from '../src/v1-scheduled-result-service.js';
import {journalObservation} from './v1-journal-fixtures.js';
it('requires current owner confirmation and forbids client redirection, labels or clocks',()=>{
  const r={requestId:'11111111-1111-4111-8111-111111111111',matchId:'9007199254742888',providerSeriesId:'321',sourceUrl:'https://example.test/synthetic',rationale:'Synthetic owner-reviewed exact meeting association',confirmedByOwner:true};
  expect(V1ScheduledBindingCreateSchema.parse(r)).toEqual(r);
  for(const patch of [{confirmedByOwner:false},{predictionRequestId:r.requestId},{targetSha256:'a'.repeat(64)},{teamAWon:true},{reviewedAt:'2000-01-01T00:00:00Z'},{matchId:123}])
    expect(V1ScheduledBindingCreateSchema.safeParse({...r,...patch}).success).toBe(false);
  expect(V1ScheduledOutcomeRefreshSchema.safeParse({requestId:r.requestId,expectedRevision:0,matchId:r.matchId}).success).toBe(false);
});
it('preserves outcome semantics and version hashes while removing unrestricted observation JSON',()=>{
  const result=journalObservation().verification;if(!result)throw Error('fixture');result.mapNumberEvidence=[{privateValue:'do-not-expose'}];
  const view=scheduledOutcomeView({revision:1,sha256:'a'.repeat(64),previousSha256:null,result});
  expect(view.result).toMatchObject({prospectiveEligible:true,rosterStatus:'matched',outcome:{teamAWon:true}});
  expect(JSON.stringify(view)).not.toMatch(/mapNumberEvidence|do-not-expose/);expect(view.sha256).toBe('a'.repeat(64));
});
