import {expect,it} from 'vitest';
import {V1ForecastRequestSchema,V1AnyRealTargetSchema} from '@dota/contracts';
import {runtimeFixture} from './v1-runtime-fixtures.js';
import {lifecycleTargetKey} from '../src/v1-journal-v2.js';
it('keeps provider identities distinct and requires versioned pinned schedule evidence',()=>{
  const target={provider:'pandascore',bindingVersion:1,providerMatchId:'9007199254742999',mapNumber:1,
    targetRequestId:runtimeFixture().request.requestId,targetSha256:'a'.repeat(64)};
  expect(V1ForecastRequestSchema.safeParse({...runtimeFixture().request,purpose:'real_map',realTarget:target}).success).toBe(true);
  for(const patch of [{bindingVersion:2},{mapNumber:2},{providerSeriesId:target.providerMatchId},{targetSha256:null},{targetRequestId:null},{selectedAt:'2026-01-01T00:00:00.000Z'}])
    expect(V1AnyRealTargetSchema.safeParse({...target,...patch}).success).toBe(false);
  expect(lifecycleTargetKey({provider:'pandascore',providerMatchId:'1',mapNumber:1})).not.toBe(lifecycleTargetKey({provider:'opendota',providerSeriesId:'1',mapNumber:1}));
});
