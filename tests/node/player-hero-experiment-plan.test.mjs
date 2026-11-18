import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPlayerHeroExperimentPlan as build,experimentPolicy} from '../../tools/research/player-hero-experiment-plan.mjs';
function fixture(){
 const ids=['9007199254740993','9007199254740994','9007199254740995','9007199254740996'];
 const windows=['train','validation','calibration','development_test'],dates=['2026-02-01','2026-06-01','2026-08-01','2026-10-01'];
 return {registeredAt:'2026-11-13T20:00:00.000Z',featurePolicy:experimentPolicy().featureContract,addedHistoryIds:[],
  targets:ids.map((matchId,i)=>({matchId,seriesKey:JSON.stringify(['opendota',String(i+1)]),nominalWindow:windows[i],pairedEligible:true})),
  features:ids.map((matchId,i)=>({matchId,nominalWindow:windows[i],originalPairedEligible:true,status:i<2?'computed_research_only':'not_requested',feature:i<2?0:null})),
  metadata:ids.map((matchId,i)=>({matchId,seriesId:'canonical:'+i,startedAt:dates[i]+'T00:00:00.000Z',completedAt:dates[i]+'T01:00:00.000Z',
   mapNumber:null,leagueId:null,dataRevision:'1',sourceSeriesId:String(i+1),seriesProvider:'opendota',gameMode:'2',lobbyType:'1'}))};
}
test('registers exact baseline/candidate, fixed fitting and research-only quality rules without reading labels',()=>{
 const f=fixture(),before=structuredClone(f),p=build(f);assert.deepEqual(f,before);
 assert.equal(p.targetLedger.count,4);assert.equal(p.exposure.independentMapsEstablished,0);
 assert.deepEqual(p.policy.models.H1.features,['eloLogit']);assert.deepEqual(p.policy.models.H2.features,['eloLogit','observedHeroPracticeLog90Delta']);
 assert.deepEqual(p.policy.fitting.CGrid,[.01,.1,1]);assert.equal(p.policy.fitting.refitAfterSelection,false);
 assert.equal(p.policy.missingness.minimumHeroGames,null);assert.equal(p.policy.release.activationAllowed,false);
 assert.equal(p.policy.independentEvaluation.from,null);assert.equal(p.policy.independentEvaluation.until,null);
 assert.equal(p.action.fittingPerformed,false);assert.equal(p.action.scoringPerformed,false);
});
test('keeps original exclusions/full denominators and history-only maps outside targets',()=>{
 const f=fixture();f.targets[0].pairedEligible=false;Object.assign(f.features[0],{originalPairedEligible:false,status:'originally_ineligible',feature:null});
 const added={...f.metadata[0],matchId:'99',seriesId:'history',sourceSeriesId:'99'};f.metadata.push(added);f.addedHistoryIds.push('99');
 const p=build(f),train=p.targetLedger.windows.find(w=>w.name==='train');assert.equal(train.plannedDenominator,1);assert.equal(train.r2EligibleUpperBound,0);
 assert.equal(p.exposure.maps,5);assert.equal(p.targetLedger.count,4);assert.deepEqual(p.targetLedger.addedHistoryOnlyIds,['99']);
});
test('rejects feature/window/target drift, duplicates, foreign history and consumed protected blocks',()=>{
 const changes=[f=>f.targets.push(f.targets[0]),f=>f.features.pop(),f=>f.metadata.push(f.metadata[0]),
  f=>f.featurePolicy.days=30,f=>f.features[0].feature=null,f=>f.features[0].feature=NaN,
  f=>f.features[0].originalPairedEligible=false,f=>f.targets[0].nominalWindow='validation',
  f=>{f.features[2].status='computed_research_only';f.features[2].feature=0;},
  f=>f.addedHistoryIds.push(f.targets[0].matchId),f=>f.metadata.pop()];
 for(const change of changes){const f=fixture();change(f);assert.throws(()=>build(f));}
});
test('rejects partial eligible series, aliases, crossing boundaries, future or equal completion',()=>{
 const changes=[f=>f.metadata[0].completedAt='2026-05-01T00:00:00.000Z',f=>f.metadata[0].completedAt=f.metadata[0].startedAt,
  f=>f.metadata[0].startedAt='2027-01-01T00:00:00.000Z',f=>f.targets[0].seriesKey=null,
  f=>f.metadata[1].seriesId=f.metadata[0].seriesId,
  f=>{f.metadata[1].sourceSeriesId='1';f.metadata[1].seriesId=f.metadata[0].seriesId;f.targets[1].seriesKey=f.targets[0].seriesKey;}];
 for(const change of changes){const f=fixture();change(f);assert.throws(()=>build(f));}
 const f=fixture();f.metadata.push({...f.metadata[0],matchId:'98'});f.targets.push({...f.targets[0],matchId:'98',pairedEligible:false});
 f.features.push({...f.features[0],matchId:'98',originalPairedEligible:false,status:'originally_ineligible',feature:null});assert.throws(()=>build(f),/mixed_eligible_series/);
});
test('unknown series stays in exposure ledger when originally excluded, not independent evidence',()=>{
 const f=fixture();f.targets[0].pairedEligible=false;f.targets[0].seriesKey=null;f.metadata[0].seriesId=null;
 Object.assign(f.features[0],{originalPairedEligible:false,status:'originally_ineligible',feature:null});
 assert.deepEqual(build(f).exposure.unknownSeriesMapIds,[f.targets[0].matchId]);
});
test('strict planner DTO rejects labels, outcomes, probabilities and policy overrides',()=>{
 for(const change of [f=>f.targets[0].label=true,f=>f.metadata[0].radiantWin=true,f=>f.features[0].probability=.9,f=>f.policyOverride={CGrid:[10]}]){
  const f=fixture();change(f);assert.throws(()=>build(f));
 }
});
test('stable ID ordering and policy copies prevent mutable configuration drift',()=>{
 const f=fixture(),p=build(f);f.targets.reverse();f.features.reverse();f.metadata.reverse();assert.deepEqual(build(f),p);
 p.policy.fitting.CGrid.push(100);assert.deepEqual(build(f).policy.fitting.CGrid,[.01,.1,1]);
});
