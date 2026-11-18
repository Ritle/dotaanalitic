import test from 'node:test';
import assert from 'node:assert/strict';
import {assemblePlayerHeroDataset,verifyPlayerHeroLabels} from '../../tools/research/player-hero-experiment-dataset.mjs';

const hash='a'.repeat(64);
const label=(id,win=true)=>({matchId:id,teamAWon:win,completedAt:'2026-01-02T02:00:00.000Z',verifiedAt:'2026-11-01T00:00:00.000Z',receiptId:id,
 sourceEvidence:{receiptId:id,payloadSha256:hash,adapterVersion:'synthetic-test',normalizerVersion:'synthetic-test',receiptFetchedAt:'2026-10-01T00:00:00.000Z'}});
function fixture(){
 const ids=['1','2','3'];
 return {targets:ids.map(id=>({matchId:id,seriesKey:id==='3'?'series2':'series1',nominalWindow:'train',originalPairedEligible:true,
  baselineEligible:true,reasons:[],eloLogit:.25,eloSnapshotSha256:hash,teamAId:'11',teamBId:'12',teamASide:'radiant'})),
  features:ids.map(id=>({matchId:id,status:'computed_research_only',value:0,snapshotSha256:hash,reasons:[]})),
  metadata:ids.map(id=>({matchId:id,seriesKey:id==='3'?'series2':'series1',startedAt:'2026-01-02T00:00:00.000Z',completedAt:'2026-01-02T02:00:00.000Z'})),
  labels:ids.map(id=>label(id,id!=='2')),addedHistoryIds:[]};
}
test('synthetic: exact paired inputs, observed zero retained, full denominator and separated labels',()=>{
 const d=assemblePlayerHeroDataset(fixture());assert.equal(d.targetLedger.count,3);assert.equal(d.labelCount,3);
 assert.deepEqual(d.featureOrder,['eloLogit','observedHeroPracticeLog90Delta']);
 assert.deepEqual(d.rows[0].inputs,{eloLogit:.25,observedHeroPracticeLog90Delta:0});
 assert.equal(d.partitions.train.pairedMaps,3);assert.equal(d.partitions.train.pairedSeries,2);
 assert.deepEqual(d.partitions.train.labels,{teamAWins:2,teamBWins:1});
 assert.equal(d.partitions.calibration.pairedCoverage,null);
 assert(!JSON.stringify(d.rows).includes('teamAWon'));assert.equal(d.deployable,false);assert.equal(d.independentTest,false);
});
test('synthetic: an unavailable feature excludes the whole known series, retaining baseline and denominator',()=>{
 const x=fixture();Object.assign(x.features[0],{status:'unavailable',value:null,reasons:['HISTORY_WINDOW_START_TRUNCATED']});
 const d=assemblePlayerHeroDataset(x);assert.equal(d.partitions.train.pairedMaps,1);assert.equal(d.partitions.train.baselineOnlyMaps,2);
 assert.equal(d.partitions.train.plannedDenominator,3);assert.equal(d.rows[1].inputs,null);
 assert(d.rows[1].reasons.includes('SERIES_HAS_UNAVAILABLE_PRACTICE'));assert(d.rows[0].reasons.includes('HISTORY_WINDOW_START_TRUNCATED'));
});
test('synthetic: missing, extra, duplicate maps and history-only IDs cannot change target denominator',()=>{
 for(const alter of [x=>x.features.pop(),x=>x.targets.push(x.targets[0]),x=>x.features.push(x.features[0]),x=>x.labels.push(x.labels[0]),
  x=>x.metadata.pop(),x=>x.addedHistoryIds.push('1'),x=>x.labels.push(label('99'))]){
  const x=fixture();alter(x);assert.throws(()=>assemblePlayerHeroDataset(x));
 }
 const x=fixture();x.addedHistoryIds=['99'];x.metadata.push({...x.metadata[2],matchId:'99'});
 const d=assemblePlayerHeroDataset(x);assert.equal(d.targetLedger.count,3);assert.deepEqual(d.targetLedger.addedHistoryOnlyIds,['99']);
});
test('synthetic: known history-only sibling crossing boundary and same-series partial eligibility rejected',()=>{
 for(const alter of [x=>x.metadata[0].completedAt='2026-05-01T00:00:00.000Z',x=>x.metadata[0].startedAt='2026-05-01T00:00:00.000Z',
  x=>x.metadata[0].completedAt=x.metadata[0].startedAt,x=>x.metadata[0].seriesKey=null,
  x=>x.targets[0].originalPairedEligible=false,
  x=>{x.addedHistoryIds=['99'];x.metadata.push({...x.metadata[0],matchId:'99',startedAt:'2026-05-01T00:00:00.000Z'});}]){
  const x=fixture();alter(x);assert.throws(()=>assemblePlayerHeroDataset(x));
 }
});
test('synthetic: missing labels and nonfinite/null successful inputs fail closed; no imputation',()=>{
 for(const alter of [x=>x.labels.pop(),x=>x.features[0].value=NaN,x=>x.features[0].value=Infinity,x=>x.features[0].value=null,
  x=>x.targets[0].eloLogit=null,x=>x.targets[0].eloSnapshotSha256=null,x=>x.features[0].snapshotSha256=null]){
  const x=fixture();alter(x);assert.throws(()=>assemblePlayerHeroDataset(x));
 }
});
test('synthetic: originally excluded and outside-window targets remain with unchanged dispositions',()=>{
 const x=fixture();x.targets[2].originalPairedEligible=false;x.targets[2].baselineEligible=false;x.targets[2].reasons=['INSUFFICIENT_PLAYER_HISTORY'];
 Object.assign(x.features[2],{status:'originally_ineligible',value:null,snapshotSha256:null});
 assert.equal(assemblePlayerHeroDataset(x).partitions.train.unavailableMaps,1);
 x.targets[2].nominalWindow=null;x.metadata[2].startedAt='2023-01-02T00:00:00.000Z';x.features[2].status='not_requested';
 const d=assemblePlayerHeroDataset(x);assert.equal(d.targetLedger.outsideWindows,1);assert.equal(d.targetLedger.count,3);
});
test('synthetic: strict feature DTO rejects outcome/probability leakage and order is stable',()=>{
 for(const field of ['teamAWon','outcome','probability','kills']){
  const x=fixture();x.features[0][field]=true;assert.throws(()=>assemblePlayerHeroDataset(x));
 }
 const x=fixture(),before=structuredClone(x),d=assemblePlayerHeroDataset(x);assert.deepEqual(x,before);
 x.targets.reverse();x.features.reverse();x.metadata.reverse();x.labels.reverse();assert.deepEqual(assemblePlayerHeroDataset(x),d);
});
const fact=l=>({matchId:l.matchId,isPro:true,verified:true,radiantWin:true,radiantTeamId:'11',direTeamId:'12',
 startedAt:'2026-01-02T00:00:00.000Z',completedAt:l.completedAt,label:l});
test('synthetic: verified labels bind canonical A/B independently of Radiant/Dire',()=>{
 const a=label('1'),b=label('2',false);const facts=[fact(a),{...fact(b),radiantTeamId:'12',direTeamId:'11'}];
 assert.deepEqual(verifyPlayerHeroLabels([a,b],facts),[a,b]);
 facts[1].radiantTeamId='11';facts[1].direTeamId='12';assert.throws(()=>verifyPlayerHeroLabels([a,b],facts));
});
test('synthetic: unverifiable, public, premature, replaced and duplicate labels rejected',()=>{
 for(const alter of [f=>f.verified=false,f=>f.isPro=false,f=>f.isPro=null,f=>f.radiantWin=null,f=>f.direTeamId=null,
  f=>f.label.sourceEvidence.payloadSha256='b'.repeat(64),f=>f.startedAt=f.completedAt]){
  const l=label('1'),f=fact(structuredClone(l));alter(f);assert.throws(()=>verifyPlayerHeroLabels([l],[f]));
 }
 for(const alter of [l=>l.verifiedAt='2026-01-01T00:00:00.000Z',l=>l.sourceEvidence.receiptFetchedAt='2026-01-01T00:00:00.000Z',
  l=>l.sourceEvidence.receiptFetchedAt='2026-12-01T00:00:00.000Z',l=>l.receiptId='2']){
  const l=label('1');alter(l);assert.throws(()=>verifyPlayerHeroLabels([l],[fact(l)]));
 }
 const l=label('1');assert.throws(()=>verifyPlayerHeroLabels([l,l],[fact(l)]));
});
