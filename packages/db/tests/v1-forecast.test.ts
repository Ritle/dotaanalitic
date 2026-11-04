import { expect, it } from 'vitest';
import { V1ForecastRequestSchema, V1RuntimeRequestSchema, V1OutcomeRefreshSchema, type V1ForecastOutcome } from '@dota/contracts';
import { forecastOutcomeFingerprint } from '../src/v1-forecast-outcomes.js';
import { runtimeFixture } from './v1-runtime-fixtures.js';
it('requires an explicit supported first map and keeps old what-if payloads unchanged', () => {
  const f=runtimeFixture(), input={...f.request,purpose:'real_map',realTarget:{provider:'opendota',providerSeriesId:'123',mapNumber:1,
    sourceUrl:'https://example.test/synthetic',rationale:'Synthetic reviewed series reference'}};
  expect(V1ForecastRequestSchema.parse(input).realTarget.mapNumber).toBe(1);
  expect(V1RuntimeRequestSchema.safeParse(input).success).toBe(false);
  expect(V1RuntimeRequestSchema.parse(f.request)).toEqual(f.request);
  for(const realTarget of [{...input.realTarget,mapNumber:2},{...input.realTarget,provider:'pandascore'},
    {...input.realTarget,sourceUrl:'javascript:alert(1)'},{...input.realTarget,providerSeriesId:'9223372036854775808'}])
    expect(V1ForecastRequestSchema.safeParse({...input,realTarget}).success).toBe(false);
});
it('refresh never accepts a caller supplied label, time or probability', () => {
  const f=runtimeFixture(), input={requestId:f.request.requestId,predictionRequestId:f.request.requestId,matchId:'1',expectedRevision:0};
  expect(V1OutcomeRefreshSchema.safeParse(input).success).toBe(true);
  for(const extra of [{winner:true},{checkedAt:'2020-01-01T00:00:00.000Z'},{probability:0.99}])
    expect(V1OutcomeRefreshSchema.safeParse({...input,...extra}).success).toBe(false);
});
it('ignores refresh clock only while retaining changed result/evidence in revision identity', () => {
  const f=runtimeFixture(), result:V1ForecastOutcome={policyVersion:'verified-first-map-forecast-v1',predictionId:f.scenario.id,
    matchId:'1',checkedAt:'2026-01-01T00:00:00.000Z',status:'unlinked',prospectiveEligible:false,rosterStatus:'unknown',
    reasons:['MAP_NOT_FOUND'],teamASide:null,mapNumberEvidence:[],outcome:null};
  expect(forecastOutcomeFingerprint({...result,checkedAt:'2026-02-01T00:00:00.000Z'})).toBe(forecastOutcomeFingerprint(result));
  expect(forecastOutcomeFingerprint({...result,reasons:['TARGET_TEAMS_MISMATCH']})).not.toBe(forecastOutcomeFingerprint(result));
});
