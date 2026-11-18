import test from 'node:test';
import assert from 'node:assert/strict';
import {buildConditionalFutureFeatures as build,buildConditionalFutureHoldout as assemble} from '../../.tools/s304-future-runtime/conditional-future-holdout.mjs';
import {createPlayerHeroFeatureBuilder} from '../../.tools/s304-future-runtime/player-hero-feature.mjs';
import {createV1FeatureBuilder} from '../../packages/prediction/dist/index.js';
import {featureFixture,bundleFixture,T,day,series} from '../fixtures/conditional-future-holdout.mjs';
const close=(a,b)=>assert(Math.abs(a-b)<1e-12,`${a} != ${b}`);
test('reuses frozen numeric recipes; accepts explicitly reconstructed availability, no scoring',()=>{
 const f=featureFixture(),before=structuredClone(f),r=build(f);
 assert.equal(r.status,'ready_offline_features');assert.equal(r.teamAWinProbability,null);
 assert.deepEqual(r.eloSnapshot,createV1FeatureBuilder(f.history)(r.eloSnapshot.scenario));
 assert.deepEqual(r.heroSnapshot,createPlayerHeroFeatureBuilder(f.heroHistory)(r.heroSnapshot.scenario));
 close(r.inputs.observedHeroPracticeLog90Delta,(Math.log(6)-Math.log(7))/5);
 close(r.inputs.eloLogit,Math.log(10)*r.eloSnapshot.features.eloDifference/400);
 assert.deepEqual(f,before);assert.throws(()=>{r.inputs.eloLogit=0;},TypeError);
 assert.equal(r.deployable,false);assert.equal(r.registrationAllowed,false);
});
test('canonical team orientation uses slots, shuffled arrays do not change inputs',()=>{
 const f=featureFixture(),r=build(f);f.target.players.reverse();f.history.maps.reverse();f.heroHistory.maps.reverse();
 assert.deepEqual(build(f).inputs,r.inputs);
 [f.target.radiantTeamId,f.target.direTeamId]=[f.target.direTeamId,f.target.radiantTeamId];
 const swapped=build(f);close(swapped.inputs.eloLogit,-r.inputs.eloLogit);close(swapped.inputs.observedHeroPracticeLog90Delta,-r.inputs.observedHeroPracticeLog90Delta);
});
test('target outcome and other target telemetry cannot enter feature boundary',()=>{
 for(const field of ['teamAWon','radiantWin','duration','kills','GPM','inputs']){const f=featureFixture();f.target[field]=1;assert.throws(()=>build(f));}
 const f=featureFixture();f.history.maps[0].matchId=f.target.matchId;f.heroHistory.maps[0].matchId=f.target.matchId;
 assert.throws(()=>build(f),/target_outcome_forbidden/);
});
test('target series is excluded from both recipes; another map with the same ten remains history',()=>{
 const f=featureFixture();f.history.maps[0].seriesKey=f.target.seriesKey;const r=build(f);
 assert.equal(r.status,'ready_offline_features');assert.equal(r.eloSnapshot.coverage.nRaw,5);
 assert(!r.heroSnapshot.history.usedMatchIds.includes(f.history.maps[0].matchId));
 const g=structuredClone(f);g.history.maps[0].teamAWon=!g.history.maps[0].teamAWon;g.heroHistory.maps[0].players[0].heroId=21;
 assert.deepEqual(build(g).inputs,r.inputs);
});
for(const boundary of ['startedAtUs','completedAtUs'])test(boundary+' equality at cutoff is excluded, never rounded',()=>{
 const f=featureFixture(),m=f.history.maps[0],h=f.heroHistory.maps[0];m[boundary]=h[boundary]=String(T);
 if(boundary==='startedAtUs')m.completedAtUs=h.completedAtUs=String(T+1n);
 const r=build(f);assert.equal(r.eloSnapshot.coverage.nRaw,5);assert.equal(r.status,'ready_offline_features');
});
test('missing sidecar, altered receipt/account and duplicate maps reject',()=>{
 for(const mutate of [f=>f.heroHistory.maps.pop(),f=>f.heroHistory.maps[0].players[0].accountId='777',
  f=>f.heroHistory.maps[0].receiptSha256='b'.repeat(64),f=>f.history.maps.push(f.history.maps[0])]){
  const f=featureFixture();mutate(f);assert.throws(()=>build(f));
 }
});
test('unknown heroes remain annotated; zero practice is not invented skill',()=>{
 const f=featureFixture();for(const m of f.heroHistory.maps)for(const p of m.players)p.heroId=null;
 const r=build(f);assert.equal(r.status,'ready_offline_features');assert.equal(r.inputs.observedHeroPracticeLog90Delta,0);
 assert(r.heroSnapshot.warnings.includes('HERO_HISTORY_INCOMPLETE'));assert.equal(r.heroSnapshot.teamA[0].nRaw,0);
});
test('missing identities and insufficient history are unavailable, not fallback probabilities',()=>{
 const f=featureFixture();f.history.identities=[];const r=build(f);assert.equal(r.inputs,null);assert.equal(r.teamAWinProbability,null);
 const g=featureFixture();g.history.maps=g.history.maps.slice(0,4);g.heroHistory.maps=g.heroHistory.maps.slice(0,4);
 assert(build(g).reasons.includes('INSUFFICIENT_PLAYER_HISTORY'));
});
test('missing target fields remain counted and remove the whole series from paired rows',()=>{
 const f=bundleFixture();f.cases[0].target.players[0].heroId=null;const r=assemble(f);
 assert.equal(r.denominator,2);assert.equal(r.pairedMaps,0);assert.equal(r.pairedCoverage,0);
 assert(r.rows.every(row=>row.inputs===null&&row.reasons.includes('SERIES_HAS_UNAVAILABLE_MEMBER')));
});
test('empty sample has null coverage; complete cases are deterministic and never claim registration',()=>{
 const f=bundleFixture(),r=assemble(f);assert.equal(r.pairedMaps,2);assert.equal(r.pairedCoverage,1);
 f.cases.reverse();f.series[0].mapIds.reverse();assert.deepEqual(assemble(f),r);
 f.cases=[];f.series=[];const empty=assemble(f);assert.equal(empty.denominator,0);assert.equal(empty.pairedCoverage,null);
 assert.equal(r.independentTest,false);assert.equal(r.deployable,false);
});
for(const [name,mutate,reason] of [
 ['exposed sibling',f=>f.exposure.mapIds.push(f.cases[0].target.matchId),'EXPOSED_MAP_OR_SERIES'],
 ['exposed series',f=>f.exposure.seriesKeys.push(series('99')),'EXPOSED_MAP_OR_SERIES'],
 ['missing member',f=>f.cases.pop(),'SERIES_MEMBER_MISSING'],
 ['unknown series completeness',f=>f.series[0].complete=false,'SERIES_COMPLETENESS_UNKNOWN'],
 ['window crossing',f=>f.cases[0].target.startedAtUs=String(T-2n*day),'SERIES_OUTSIDE_WINDOW'],
 ['late completion',f=>f.series[0].completedAtUs=String(T+5n*day),'SERIES_OUTSIDE_WINDOW'],
 ['unknown inventory',f=>f.inventoryComplete=false,'DENOMINATOR_UNKNOWN'],
 ['wrong event',f=>f.cases[0].target.eventId='301','EVENT_SCOPE_MISMATCH'],
 ['missing history',f=>f.cases[0].history=null,'HISTORY_INPUT_MISSING'],
])test(name+' preserves denominator and blocks whole series',()=>{const f=bundleFixture();mutate(f);const r=assemble(f);
 assert.equal(r.pairedMaps,0);assert(r.rows.some(row=>row.reasons.includes(reason)));});
test('duplicate cases, foreign labels, malformed IDs and numeric aliases are rejected',()=>{
 for(const mutate of [f=>f.cases.push(f.cases[0]),f=>f.labels=[],f=>f.cases[0].target.matchId=9007199254741099,
  f=>f.cases[0].target.seriesKey='99']){const f=bundleFixture();mutate(f);assert.throws(()=>assemble(f));}
});
test('one microsecond before cutoff is usable; a truncated practice window is unavailable',()=>{
 const f=featureFixture();f.history.maps[0].completedAtUs=f.heroHistory.maps[0].completedAtUs=String(T-1n);
 assert.equal(build(f).eloSnapshot.coverage.nRaw,6);
 f.history.warmupFromAtUs=f.heroHistory.fromAtUs=String(T-80n*day);
 const r=build(f);assert.equal(r.inputs,null);assert(r.reasons.includes('HISTORY_WINDOW_START_TRUNCATED'));
});
test('unknown pro status or missing series cannot certify the declared denominator',()=>{
 const f=bundleFixture();f.cases[0].target.isPro=null;const r=assemble(f);
 assert.equal(r.denominator,2);assert.equal(r.denominatorComplete,false);assert.equal(r.pairedMaps,0);
 const g=bundleFixture();g.series=[];assert.equal(assemble(g).denominatorComplete,false);
});
test('known missing maps stay in denominator rather than disappearing with absent cases',()=>{
 const f=bundleFixture(),missing=f.cases.pop().target.matchId,r=assemble(f);
 assert.equal(r.denominator,2);assert.equal(r.rows.length,1);assert.deepEqual(r.missingTargetIds,[missing]);
 assert.equal(r.denominatorComplete,false);assert.equal(r.pairedCoverage,0);
});
test('even an excluded case cannot smuggle its target outcome into the saved feature input',()=>{
 const f=bundleFixture();f.exposure.mapIds.push(f.cases[0].target.matchId);
 f.cases[0].history.maps[0].matchId=f.cases[0].target.matchId;
 assert.throws(()=>assemble(f),/target_outcome_forbidden/);
});
