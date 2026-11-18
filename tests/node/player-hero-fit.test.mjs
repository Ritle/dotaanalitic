import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {preparePlayerHeroFitInput,checkPlayerHeroParity} from '../../tools/research/player-hero-fit.mjs';
import * as runtime from '../../.tools/s304-hero-fit-test-runtime/player-hero-inference.mjs';
const hash='a'.repeat(64);
function fixture(){
 const times=['2025-03-01','2026-05-01','2026-07-01','2026-09-01'],windows=['train','validation','calibration','development_test'];
 return {dataset:{format:'player-hero-experiment-dataset-v1',syntheticOnly:false,deployable:false,protocolFingerprint:hash,
  featureOrder:['eloLogit','observedHeroPracticeLog90Delta'],rows:windows.map((w,i)=>({matchId:String(i+1),seriesKey:w,nominalWindow:w,
   pairedEligible:true,originalPairedEligible:true,baselineEligible:true,reasons:[],startedAt:times[i]+'T00:00:00.000Z',inputs:{eloLogit:.2,observedHeroPracticeLog90Delta:0}}))},
  labels:{format:'player-hero-experiment-labels-v1',deployable:false,rows:windows.map((w,i)=>({matchId:String(i+1),teamAWon:i%2===0,
   completedAt:times[i]+'T01:00:00.000Z',verifiedAt:'2026-11-13T00:00:00.000Z',sourceEvidence:{payloadSha256:hash}}))}};
}
const prepare=x=>preparePlayerHeroFitInput(x.dataset,x.labels,hash,hash);
test('synthetic: projection joins labels by ID, excludes late rows before reading inputs or outcome',()=>{
 const x=fixture(),a=prepare(x);assert.equal(a.rows.length,3);assert.deepEqual(a.rows.map(r=>r.label),[true,false,true]);
 x.labels.rows.reverse();assert.deepEqual(prepare(x),a);
 const late=x.dataset.rows[3];Object.defineProperty(late,'inputs',{get(){throw Error('late inputs consumed');}});
 const label=x.labels.rows.find(r=>r.matchId==='4');Object.defineProperty(label,'teamAWon',{get(){throw Error('late label consumed');}});
 assert.deepEqual(prepare(x),a);
});
test('synthetic: missing/duplicate labels, feature leakage and partial eligibility fail closed',()=>{
 for(const change of [x=>x.labels.rows.shift(),x=>x.labels.rows.push(x.labels.rows[0]),x=>x.dataset.rows.push(x.dataset.rows[0]),
  x=>x.dataset.rows[0].inputs.outcome=true,x=>x.dataset.rows[0].inputs.observedHeroPracticeLog90Delta=null,
  x=>x.dataset.rows[0].originalPairedEligible=false,x=>x.dataset.rows[1].seriesKey='train']){
  const x=fixture();change(x);assert.throws(()=>prepare(x));
 }
});
const model={status:'fitted',featureOrder:['eloLogit','observedHeroPracticeLog90Delta'],coefficients:[1,.25],intercept:0,calibration:{status:'fitted',temperature:1}};
test('TS inference validates order/shape/finite values, swaps signs, preserves zero and null calibration',()=>{
 const inputs={eloLogit:.4,observedHeroPracticeLog90Delta:0},p=runtime.infer(model,'H2',inputs);
 const q=runtime.infer(model,'H2',{eloLogit:-.4,observedHeroPracticeLog90Delta:0});assert(Math.abs(p.rawProbability+q.rawProbability-1)<1e-14);
 assert.equal(runtime.infer({...model,calibration:{status:'insufficient',temperature:null}},'H2',inputs).calibratedProbability,null);
 for(const mutate of [m=>m.featureOrder.reverse(),m=>m.coefficients.pop(),m=>m.coefficients[0]=Infinity,m=>m.calibration.temperature=.2500005,m=>m.intercept=1]){
  const m=structuredClone(model);mutate(m);assert.throws(()=>runtime.infer(m,'H2',inputs));
 }
 assert.throws(()=>runtime.encode({...inputs,teamAWon:true}));assert.throws(()=>runtime.encode({...inputs,eloLogit:NaN}));
 assert.equal(runtime.sigmoid(-1000),0);assert.equal(runtime.sigmoid(1000),1);
});
test('Python sklearn goldens match TS, including unavailable calibration; tampered probability fails',async()=>{
 const a=JSON.parse(await readFile('.tools/s304-hero-fit-synthetic.json','utf8'));
 const result=checkPlayerHeroParity(a,runtime);assert.equal(result.status,'PASS');assert.equal(result.cases.length,6);
 assert(result.comparisons>1000);a.goldens[0].expected.H2.rawProbability+=.01;assert.throws(()=>checkPlayerHeroParity(a,runtime));
});
test('incomplete parity vectors, missing model or unknown feature fields cannot pass',async()=>{
 const original=JSON.parse(await readFile('.tools/s304-hero-fit-synthetic.json','utf8'));
 for(const change of [a=>a.goldens=a.goldens.filter(g=>g.case!=='zero_practice'),a=>delete a.goldens[0].expected.H1,
  a=>a.goldens[0].inputs.patch=1,a=>a.deployable=true]){
  const a=structuredClone(original);change(a);assert.throws(()=>checkPlayerHeroParity(a,runtime));
 }
});
