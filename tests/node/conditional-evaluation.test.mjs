import test from 'node:test';
import assert from 'node:assert/strict';
import {buildConditionalEvaluationBundle as build} from '../../tools/research/conditional-evaluation.mjs';
import {evaluationFixture} from '../fixtures/conditional-evaluation.mjs';
import {editRegister} from '../fixtures/conditional-enrollment.mjs';
import {bindFixture} from '../fixtures/conditional-source-binding.mjs';

test('source replay joins one paired cohort for every variant with labels separate',()=>{
 const f=evaluationFixture(),before=structuredClone(f),r=build(f);
 assert.equal(r.cohort.status,'prepared_local_inputs');assert.equal(r.cohort.counts.verifiedProDenominator,2);
 assert.equal(r.cohort.counts.pairedMaps,2);assert.equal(r.cohort.pairedCoverage,1);
 assert.deepEqual(r.features.rows.map(x=>x.matchId),r.labels.rows.map(x=>x.matchId));
 assert(!JSON.stringify(r.features).includes('teamAWon'));assert(!JSON.stringify(r.features).includes('completedAt'));
 assert.equal(r.cohort.scoringPerformed,false);assert.equal(r.cohort.evaluationAllowed,false);assert.equal(r.cohort.deployable,false);
 assert.deepEqual(f,before);
});

for(const [name,change] of [
 ['window',f=>f.featureInput.window.fromAtUs='1'],
 ['scope',f=>f.featureInput.eventIds=['301']],
 ['prepared IDs',f=>f.enrollmentInput.preparedTargetIds.pop()],
 ['series members',f=>f.featureInput.series[0].mapIds.pop()],
 ['series completion',f=>f.featureInput.series[0].completedAtUs='1'],
 ['exposure lists',f=>f.enrollmentInput.exposure.mapIds.push('9')],
 ['exposure SHA',f=>f.featureInput.exposure.sourceSha256='b'.repeat(64)],
 ['dropped frozen map',f=>f.requiredExposure.mapIds.push('9')],
 ['dropped frozen series',f=>f.requiredExposure.seriesKeys.push('["opendota","9"]')],
 ['synthetic mixing',f=>f.enrollmentInput.syntheticOnly=false],
 ['unknown fields',f=>f.evaluationAllowed=true],
])test('rejects contradictory '+name,()=>{const f=evaluationFixture();change(f);assert.throws(()=>build(f));});

test('missing features preserve denominator and exclude the whole common series',()=>{
 const f=evaluationFixture();f.featureInput.cases[0].heroHistory=null;
 const r=build(f);assert.equal(r.cohort.counts.verifiedProDenominator,2);assert.equal(r.cohort.counts.pairedMaps,0);
 assert.equal(r.cohort.pairedCoverage,0);assert(r.cohort.rows.every(x=>!x.pairedEligible));assert.equal(r.features.rows.length,0);
});
test('missing pages refuse cohort preparation without reducing known denominator',()=>{
 const f=evaluationFixture();f.enrollmentInput.pages=[];const r=build(f);
 assert.equal(r.cohort.status,'insufficient');assert.equal(r.cohort.counts.verifiedProDenominator,2);
 assert.equal(r.cohort.pairedCoverage,null);assert.equal(r.features.rows.length,0);assert.equal(r.labels.rows.length,0);
});
test('unprepared map remains in denominator and closes its sibling series',()=>{
 const f=evaluationFixture(),id=f.featureInput.cases.pop().target.matchId;
 f.enrollmentInput.preparedTargetIds=f.enrollmentInput.preparedTargetIds.filter(x=>x!==id);
 f.archive.targetMapIds=f.archive.targetMapIds.filter(x=>x!==id);
 const r=build(f);assert.equal(r.cohort.counts.verifiedProDenominator,2);assert.equal(r.cohort.counts.pairedMaps,0);
 assert(r.cohort.rows.find(x=>x.matchId===id).reasons.includes('FEATURE_INPUT_MISSING'));
});
test('exposed sibling excludes every model without shrinking denominator',()=>{
 const f=evaluationFixture(),id=f.featureInput.cases[0].target.matchId;
 f.featureInput.exposure.mapIds.push(id);f.enrollmentInput.exposure.mapIds.push(id);
 const r=build(f);assert.equal(r.cohort.counts.verifiedProDenominator,2);assert.equal(r.cohort.counts.pairedMaps,0);
});
test('cross-window series keeps only in-window maps in denominator and no paired rows',()=>{
 const f=evaluationFixture();f.enrollmentInput.window.fromAt=new Date(Date.parse(f.enrollmentInput.window.fromAt)+1000).toISOString();
 f.featureInput.window.fromAtUs=String(BigInt(Date.parse(f.enrollmentInput.window.fromAt))*1000n);
 const r=build(f);assert.equal(r.cohort.counts.verifiedProDenominator,1);assert.equal(r.cohort.counts.pairedMaps,0);
});
test('partial source mismatch does not silently use the declared numeric feature',()=>{
 const f=evaluationFixture();f.featureInput.cases[0].target.players[0].heroId=99;
 const r=build(f);assert.equal(r.cohort.counts.pairedMaps,0);assert(r.cohort.rows.some(x=>x.reasons.includes('TARGET_SOURCE_MISMATCH')));
});
test('unknown metadata in retained universe is insufficient, not an empty zero-rate result',()=>{
 const f=evaluationFixture();editRegister({input:f.enrollmentInput},r=>r.series.push({nativeSeriesId:'100',state:'finished',mapIds:['1000'],completedAt:r.series[0].completedAt}));
 const r=build(f);assert.equal(r.cohort.denominatorComplete,false);assert.equal(r.cohort.counts.knownPossibleMaps,3);assert.equal(r.cohort.pairedCoverage,null);
});
test('provider patch and missingness remain annotations without changing numeric feature order',()=>{
 const f=evaluationFixture();
 for(const receipt of f.archive.receipts){const raw=JSON.parse(receipt.rawBody);raw.patch=42;
  if(f.archive.historyMapIds.includes(receipt.matchId))raw.players[0].hero_id=null;
  receipt.rawBody=JSON.stringify(raw);
 }
 bindFixture({input:f.featureInput,archive:f.archive});const r=build(f);
 assert.equal(r.features.rows.length,2);
 for(const row of r.features.rows){assert.equal(row.annotations.providerPatchId,'42');
  assert.equal(row.annotations.hasUnknownHeroHistory,true);assert.equal(row.annotations.hasZeroObservedHeroCount,true);
  assert.equal(row.encoded.H1.length,1);assert.equal(row.encoded.H2.length,2);}
});
test('changing a target label never changes numeric inputs or membership',()=>{
 const f=evaluationFixture(),before=build(f);const receipt=f.archive.receipts.find(r=>f.archive.targetMapIds.includes(r.matchId));
 const raw=JSON.parse(receipt.rawBody);raw.radiant_win=!raw.radiant_win;receipt.rawBody=JSON.stringify(raw);
 bindFixture({input:f.featureInput,archive:f.archive});const after=build(f);
 assert.deepEqual(before.cohort.pairedMapIds,after.cohort.pairedMapIds);
 assert.deepEqual(before.features.rows.map(r=>r.inputs),after.features.rows.map(r=>r.inputs));
 assert.notDeepEqual(before.labels.rows.map(r=>r.teamAWon),after.labels.rows.map(r=>r.teamAWon));
});
