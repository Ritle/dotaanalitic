import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildIndependentValidationPlan as build, independentPolicy} from '../../tools/research/player-hero-independent-plan.mjs';

const oldPolicy = JSON.parse(await readFile(new URL('../../tools/research/player-hero-experiment-policy.json',import.meta.url),'utf8'));
function fixture() {
  return {preparedAt:'2026-11-13T23:00:00.000Z', candidateSha256:'a'.repeat(64),
    models:{H1:{featureOrder:['eloLogit'],coefficients:[.8],temperature:.9,intercept:0},
      H2:{featureOrder:['eloLogit','observedHeroPracticeLog90Delta'],coefficients:[.7,.1],temperature:.8,intercept:0}},
    exposure:{mapIds:['9007199254740994','9007199254740993','3'],
      canonicalSeriesKeys:['["opendota","9007199254740993"]'],unknownSeriesMapIds:['3'],
      latestFrozenEvent:'2026-11-04T20:07:52.000Z'}};
}

test('prepares a protocol without pretending to register, collect, score or activate',()=>{
  const p=build(fixture());assert.equal(p.status,'prepared_not_registered');
  assert.equal(p.policy.registration.registeredAt,null);assert.equal(p.policy.registration.eventEditionScope,null);
  assert.equal(p.policy.registration.from,null);assert.equal(p.policy.registration.until,null);
  assert.equal(p.policy.registration.executableManifestSha256,null);
  assert.equal(p.readiness.registrationAllowed,false);assert.equal(p.readiness.collectionAllowed,false);
  assert.equal(p.minimumExposureBlocklist.independentMapsEstablished,0);
  assert.equal(p.minimumExposureBlocklist.completeProjectInventory,false);
  assert(Object.values(p.action).every(value=>value===false||value===0));
  assert.equal(p.deployable,false);assert.equal(p.releaseGatePassed,false);
});

test('inherits exact frozen criteria, recipe, zero-count policy and candidate parameters',()=>{
  const f=fixture(),p=build(f);
  assert.deepEqual(p.candidate.models,f.models);
  assert.deepEqual(p.inheritedCriteria.evaluation,oldPolicy.evaluation);
  assert.deepEqual(p.inheritedCriteria.sampleFloors,oldPolicy.sampleFloors);
  assert.deepEqual(p.inheritedCriteria.featureContract,oldPolicy.featureContract);
  assert.deepEqual(p.inheritedCriteria.missingness,oldPolicy.missingness);
  assert.equal(p.inheritedCriteria.missingness.minimumHeroGames,null);
  assert.equal(p.inheritedCriteria.evaluation.pairedCoverageMinimum,.8);
});

test('retains all exposed IDs as strings, including unknown series and non-test history',()=>{
  const p=build(fixture());assert.deepEqual(p.minimumExposureBlocklist.mapIds,['3','9007199254740993','9007199254740994']);
  assert.deepEqual(p.minimumExposureBlocklist.unknownSeriesMapIds,['3']);
  assert.equal(p.minimumExposureBlocklist.maps,3);assert.equal(p.minimumExposureBlocklist.knownSeries,1);
});

test('is deterministic for shuffled exposure and does not mutate inputs or policies',()=>{
  const f=fixture(),before=structuredClone(f),p=build(f);assert.deepEqual(f,before);
  f.exposure.mapIds.reverse();assert.deepEqual(build(f),p);
  p.policy.registration.collectionAllowed=true;p.inheritedCriteria.evaluation.pairedCoverageMinimum=0;
  const policy=independentPolicy();policy.registration.registeredAt='forged';
  assert.equal(build(f).policy.registration.collectionAllowed,false);
  assert.equal(build(f).inheritedCriteria.evaluation.pairedCoverageMinimum,.8);
  assert.equal(independentPolicy().registration.registeredAt,null);
});

test('empty exposure cannot establish independence or waive global exposure inventory',()=>{
  const f=fixture();f.exposure.mapIds=[];f.exposure.canonicalSeriesKeys=[];f.exposure.unknownSeriesMapIds=[];
  const p=build(f);assert.equal(p.minimumExposureBlocklist.maps,0);assert.equal(p.readiness.registrationAllowed,false);
  assert(p.readiness.blockers.some(x=>x.includes('global_exposure')));
});

test('keeps bounded resource planning separate from current quotas and permission to collect',()=>{
  const p=build(fixture()),b=p.policy.budget;
  assert.equal(b.maxConcurrentRequests,1);assert.equal(b.maxAttemptsPerRequestKey,2);
  assert.equal(b.maxHttpAttemptsIncludingRetries,1000);assert.equal(b.maxHttpAttemptsPerUtcDay,100);
  assert.equal(b.businessDatabaseWrites,false);assert.equal(b.paidUpgradeAllowed,false);
  assert(b.quota.includes('minimum'));assert(b.exhaustion.includes('insufficient'));
  assert.equal(p.policy.registration.collectionAllowed,false);
});

test('requires prospective clocks, full denominator and separate retrospective diagnostics',()=>{
  const p=build(fixture());assert.equal(p.readiness.currentBuilderEnforcesKnownAt,false);
  assert.equal(p.readiness.sourceClockSemanticsVerified,false);
  assert(p.policy.availability.history.includes('known_at_and_fetched_at_strictly_before'));
  assert(p.policy.availability.nullKnownAt.includes('unavailable'));
  assert(p.policy.cohorts.retrospective.includes('never_pooled'));
  assert(p.policy.enrollment.unknownInventory.includes('insufficient'));
  assert(p.policy.evaluation.assessment.includes('no_metric_peeking'));
});

test('rejects source drift, duplicate identities, malformed series, unsafe numbers and extra fields',()=>{
  const changes=[f=>f.exposure.mapIds.push(f.exposure.mapIds[0]),
    f=>f.exposure.canonicalSeriesKeys.push(f.exposure.canonicalSeriesKeys[0]),
    f=>f.exposure.unknownSeriesMapIds.push('99'),f=>f.exposure.mapIds[0]=9007199254740994,
    f=>f.exposure.mapIds[0]='9223372036854775808',f=>f.exposure.canonicalSeriesKeys[0]='["opendota",123]',
    f=>f.exposure.canonicalSeriesKeys[0]='opendota:123',f=>f.exposure.latestFrozenEvent=f.preparedAt,
    f=>f.preparedAt='2026-11-99T00:00:00.000Z',f=>f.candidateSha256='secret-sentinel',
    f=>f.models.H2.featureOrder.reverse(),f=>f.models.H1.coefficients.push(.1),
    f=>f.models.H2.coefficients[0]=NaN,f=>f.models.H1.temperature=0,f=>f.models.H2.intercept=1,
    f=>f.registeredAt=f.preparedAt,f=>f.labels=[true],f=>f.models.H3=f.models.H1];
  for(const change of changes){const f=fixture();change(f);assert.throws(()=>build(f));}
});
