import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildR2Plan} from '../../tools/research/post-draft-r2-plan.mjs';
const policy=JSON.parse(await readFile(new URL('../../tools/research/post-draft-policy.json',import.meta.url),'utf8'));
function fixture(){
 const row=(matchId,day)=>({matchId,seriesId:'synthetic-series-'+matchId,startedAt:day+'T10:00:00.000Z',completedAt:day+'T11:00:00.000Z',mapNumber:null,leagueId:'1',dataRevision:'1',sourceSeriesId:matchId,seriesProvider:'opendota',gameMode:'2',lobbyType:'1'});
 const baselineMetadata=[row('9007199254740993','2026-04-01'),row('2','2026-09-02'),row('3','2026-09-03')];
 const added=[row('4','2026-08-11'),row('5','2026-09-01')];
 return {plannedAt:'2026-11-13T17:00:00.000Z',baselineMetadata,metadata:[...structuredClone(baselineMetadata),...added],addedIds:['4','5'],
  protocol:{policy:structuredClone(policy),dispositions:baselineMetadata.map(m=>({...m,nominalWindow:m.matchId==='9007199254740993'?'train':'development_test'}))},
  coverage:{minimumPriorMaps:5,counts:{importedMaps:2,targetsStillDeficient:1},contributions:added.map(m=>({matchId:m.matchId})),
   originalCohort:{denominator:2,paired:0,excluded:2},fixedCohortCoverageOnly:{upperBoundPaired:1,coverage:0.5,independentTest:false},deployable:false}};
}
test('R2 fixes parameters, retains target ledger and distinguishes unknown future registration',()=>{
 const f=fixture(),copy=structuredClone(f),r=buildR2Plan(f);assert.deepEqual(f,copy);
 assert.equal(r.targetLedger.count,3);assert.deepEqual(r.targetLedger.mapIds,['2','3','9007199254740993']);assert.equal(r.targetLedger.newHistoryMayBecomeTargets,false);
 assert.equal(r.targetLedger.partitions.find(w=>w.name==='development_test').originalTargetDenominator,2);
 assert.deepEqual(r.targetLedger.partitions.map(w=>w.addedHistoryMaps),[0,0,0,1,1]);
 assert.equal(r.parameters.coefficientFittingAllowed,false);assert.equal(r.parameters.calibrationFittingAllowed,false);
 assert.equal(r.independentEvaluation.from,null);assert.equal(r.independentEvaluation.until,null);assert.equal(r.exposure.independentMapsEstablished,0);
 assert.equal(r.deployable,false);assert.equal(r.targetScoringPerformed,false);assert.equal(r.datasetReady,false);
});
test('changed originals, duplicates and unexpected maps cannot silently change the experiment',()=>{
 for(const mutate of [f=>f.metadata.push(f.metadata[0]),f=>f.metadata[0].dataRevision='2',f=>f.metadata[0].completedAt='2026-04-01T12:00:00.000Z',f=>f.addedIds.push('4'),f=>f.addedIds[0]='2',f=>f.metadata.pop(),f=>f.protocol.dispositions.pop(),f=>f.coverage.originalCohort.denominator=1]){
  const f=fixture();mutate(f);assert.throws(()=>buildR2Plan(f));
 }
});
test('history affecting train or validation requires a different protocol, not refitting here',()=>{
 const f=fixture();f.metadata.at(-1).startedAt='2026-06-30T23:59:59.999Z';assert.throws(()=>buildR2Plan(f));
 f.metadata.at(-1).startedAt='2026-07-01T00:00:00.000Z';assert.doesNotThrow(()=>buildR2Plan(f));
});
test('future, incomplete and equal-completion additions are rejected',()=>{
 for(const mutate of [f=>f.metadata.at(-1).startedAt=f.plannedAt,f=>f.metadata.at(-1).completedAt=null,f=>f.metadata.at(-1).completedAt=f.metadata.at(-1).startedAt,f=>f.metadata.at(-1).completedAt='2026-12-01T00:00:00.000Z',f=>f.plannedAt='invalid']){
  const f=fixture();mutate(f);assert.throws(()=>buildR2Plan(f));
 }
});
test('label-bearing metadata, changed minimum and coverage lineage are refused',()=>{
 for(const mutate of [f=>f.metadata[0].radiantWin=true,f=>f.baselineMetadata[0].teamAWon=false,f=>f.coverage.minimumPriorMaps=4,f=>f.coverage.contributions[0].matchId='99',f=>f.coverage.fixedCohortCoverageOnly.independentTest=true]){
  const f=fixture();mutate(f);assert.throws(()=>buildR2Plan(f));
 }
});
test('old test dates cannot become independent even when coverage reaches 100 percent',()=>{
 const f=fixture();f.coverage.fixedCohortCoverageOnly.upperBoundPaired=2;f.coverage.fixedCohortCoverageOnly.coverage=1;
 const r=buildR2Plan(f);assert.equal(r.coveragePreview.status,'upper_bound_only_not_dataset_eligibility');assert.equal(r.exposure.independentMapsEstablished,0);
 assert.equal(r.independentEvaluation.status,'not_registered_not_ready');assert.equal(r.evaluation.probabilitiesInUIAllowed,false);
});
test('reordering observations preserves canonical target IDs and summaries',()=>{
 const f=fixture(),r=buildR2Plan(f);f.metadata.reverse();f.baselineMetadata.reverse();f.protocol.dispositions.reverse();f.addedIds.reverse();f.coverage.contributions.reverse();
 assert.deepEqual(buildR2Plan(f),r);
});
