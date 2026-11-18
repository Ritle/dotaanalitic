import test from 'node:test';
import assert from 'node:assert/strict';
import {preparePlayerHeroEvaluation} from '../../tools/research/player-hero-evaluate.mjs';
import {experimentPolicy} from '../../tools/research/player-hero-experiment-plan.mjs';
import {digest} from '../../tools/research/post-draft-dataset.mjs';
import * as runtime from '../../.tools/s304-hero-fit-r1/compiled/player-hero-inference.mjs';
const hash='a'.repeat(64),start='2026-09-10T00:00:00.000Z',end='2026-09-10T01:00:00.000Z';
function fixture(){
 const feature={status:'computed_research_only',feature:0,scenario:{targetMatchId:'1',cutoffAtUs:(BigInt(Date.parse(start))*1000n).toString()},
  teamA:Array.from({length:5},()=>({nRaw:0,heroUnknownMaps:1})),teamB:Array.from({length:5},()=>({nRaw:1,heroUnknownMaps:0}))};
 const block={pairedMaps:300,labels:{teamAWins:150,teamBWins:150}};
 const row={matchId:'1',seriesKey:'["opendota","123"]',nominalWindow:'development_test',startedAt:start,baselineEligible:true,pairedEligible:true,reasons:[],
  eloLogit:.4,inputs:{eloLogit:.4,observedHeroPracticeLog90Delta:0},practiceSnapshotSha256:digest(feature)};
 const model={status:'fitted',featureOrder:['eloLogit'],coefficients:[.8],intercept:0,calibration:{status:'fitted',temperature:.9}};
 return {dataset:{format:'player-hero-experiment-dataset-v1',syntheticOnly:false,deployable:false,protocolFingerprint:hash,rows:[row],
  partitions:{train:block,validation:block,calibration:block,development_test:{plannedDenominator:1}}},
  labels:{rows:[{matchId:'1',teamAWon:true,completedAt:end,verifiedAt:'2026-11-13T00:00:00.000Z',sourceEvidence:{payloadSha256:hash}}]},
  features:{rows:[{matchId:'1',feature}]},inventory:{maps:[{matchId:'1',startedAt:start,providerPatchId:60,canonicalPatchId:null}]},
  metadata:[{matchId:'1',startedAt:start,completedAt:end,leagueId:'10',seriesId:'known',seriesProvider:'opendota',sourceSeriesId:'123'}],
  plan:{fingerprint:hash,policy:experimentPolicy(),targetLedger:{mapIds:['1'],windows:[{name:'development_test',plannedDenominator:1}]}},
  artifact:{format:'player-hero-research-fit-v1',syntheticOnly:false,deployable:false,protocolFingerprint:hash,counts:{train:300,validation:300,calibration:300},
   models:{H1:model,H2:{...model,featureOrder:['eloLogit','observedHeroPracticeLog90Delta'],coefficients:[.8,.2]}}},sourceHashes:{},runtime};
}
test('synthetic: fixed coefficients, common map, explicit zero/unknown annotations and null canonical patch',()=>{
 const x=fixture(),before=structuredClone({...x,runtime:null});const r=preparePlayerHeroEvaluation(x);
 assert.deepEqual({...x,runtime:null},before);assert.equal(r.rows.length,1);assert.equal(r.rows[0].predictions.H1_raw.logit,.4*.8);
 assert.equal(r.rows[0].annotations.hasZeroObservedHeroCount,true);assert.equal(r.rows[0].annotations.hasUnknownHeroHistory,true);
 assert.equal(r.rows[0].annotations.canonicalPatchId,null);assert.equal(r.rows[0].annotations.providerPatchId,60);
});
test('synthetic: raw score is retained when calibrator unavailable, model missing gives null rather than 50/50',()=>{
 const x=fixture();x.artifact.models.H2.calibration={status:'insufficient',temperature:null};
 let r=preparePlayerHeroEvaluation(x);assert.equal(r.rows[0].predictions.H2_cal,null);assert(r.rows[0].predictions.H2_raw);
 x.artifact.models.H1={status:'unavailable'};r=preparePlayerHeroEvaluation(x);assert.equal(r.rows[0].predictions.H1_raw,null);
 assert(r.rows[0].reasons.includes('H1_MODEL_UNAVAILABLE'));
});
test('synthetic: full denominator and exclusions survive without invented features',()=>{
 const x=fixture();const r=x.dataset.rows[0];r.baselineEligible=false;r.pairedEligible=false;r.reasons=['INSUFFICIENT_HISTORY'];r.inputs=null;
 x.features.rows[0].feature=null;x.labels.rows=[];
 const result=preparePlayerHeroEvaluation(x);assert.equal(result.plannedDenominator,1);assert.equal(result.rows[0].label,null);
 assert(Object.values(result.rows[0].predictions).every(v=>v===null));assert.equal(result.rows[0].annotations.hasZeroObservedHeroCount,null);
});
test('synthetic: cutoff, label, series, SHA, counts and denominator drift rejected',()=>{
 for(const change of [x=>x.labels.rows=[],x=>x.labels.rows.push(x.labels.rows[0]),x=>x.features.rows[0].feature.feature=1,
  x=>x.metadata[0].sourceSeriesId='999',x=>x.labels.rows[0].completedAt=start,x=>x.dataset.rows[0].startedAt='2026-09-11T00:00:00.000Z',
  x=>x.artifact.counts.train=299,x=>x.plan.targetLedger.windows[0].plannedDenominator=2,x=>x.dataset.rows[0].inputs.outcome=true,
  x=>x.dataset.rows[0].inputs.eloLogit=.2]){
  const x=fixture();change(x);assert.throws(()=>preparePlayerHeroEvaluation(x));
 }
});
test('synthetic: early rows never scored and upstream floors cannot disappear',()=>{
 const x=fixture();x.plan.targetLedger.mapIds.push('2');x.dataset.rows.push({matchId:'2',nominalWindow:'train',get inputs(){throw Error('early scoring');}});
 x.features.rows.push({matchId:'2',feature:null});x.dataset.partitions.train={pairedMaps:10,labels:{teamAWins:5,teamBWins:5}};x.artifact.counts.train=10;
 const r=preparePlayerHeroEvaluation(x);assert.equal(r.rows.length,1);assert.equal(r.upstreamDataChecks.status,'insufficient');
 assert(r.upstreamDataChecks.reasons.includes('TRAIN_MAPS_BELOW_FLOOR'));
});
