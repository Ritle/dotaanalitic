import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareR2Input} from '../../tools/research/post-draft-r2-evaluate.mjs';
const inputs={eloLogit:.4,signedHeroes:Array.from({length:10},(_,i)=>({heroId:i+1,value:i<5?1:-1}))};
const sigmoid=x=>1/(1+Math.exp(-x));
const runtime={sigmoid,encode:x=>[x.eloLogit,...x.signedHeroes.map(h=>h.value)],infer:(m,k,x)=>({rawProbability:sigmoid(x.eloLogit),calibratedProbability:sigmoid(x.eloLogit)})};
function fixture(){
 const row=(matchId,nominalWindow)=>({matchId,seriesKey:'s'+matchId,nominalWindow,baselineEligible:true,pairedEligible:true,reasons:[],inputs});
 const dataset={deployable:false,syntheticOnly:false,protocolFingerprint:'x',dataChecks:{status:'insufficient',reasons:['COVERAGE']},rows:[row('1','train'),row('9007199254740993','development_test'),row('9007199254740994','development_test')],labels:[{matchId:'9007199254740993',teamAWon:true,sourceEvidence:{receiptId:'1'}}]};
 dataset.rows[2]={...dataset.rows[2],baselineEligible:false,pairedEligible:false,inputs:null,reasons:['INSUFFICIENT_PLAYER_HISTORY']};
 const inventory={maps:dataset.rows.map(r=>({matchId:r.matchId,startedAt:'2026-09-01T00:00:00.000Z',leagueId:'5',providerPatchId:60,canonicalPatchId:null}))};
 const protocol={fingerprint:'x',policy:{},partitions:{development_test:{plannedDenominator:2}},dispositions:inventory.maps.map(m=>({...m,nominalWindow:dataset.rows.find(r=>r.matchId===m.matchId).nominalWindow}))};
 const model=n=>({status:'fitted',coefficients:[1,...Array(n-1).fill(0)],calibration:{status:'fitted',temperature:1}});
 const artifact={deployable:false,syntheticOnly:false,protocolFingerprint:'x',heroVocabulary:Array.from({length:10},(_,i)=>i+1),models:{M1:model(1),M2:model(11)}};
 return {dataset,inventory,protocol,artifact};
}

function adapted(){
 const f=fixture();f.dataset.format='conditional-post-draft-r2-dataset-v1';f.dataset.r1ProtocolFingerprint=f.protocol.fingerprint;f.dataset.protocolFingerprint='R2';
 f.dataset.heroVocabulary=f.artifact.heroVocabulary;f.dataset.policy=f.protocol.policy;
 f.dataset.earlyParity={train:{status:'exact_except_declared_snapshot_provenance'},validation:{status:'exact_except_declared_snapshot_provenance'}};
 f.plan={fingerprint:'R2',inheritedPolicy:f.protocol.policy,targetLedger:{mapIds:f.dataset.rows.map(r=>r.matchId)},parameters:{coefficientFittingAllowed:false,calibrationFittingAllowed:false}};
 return f;
}
const run=f=>prepareR2Input(f.dataset,f.plan,f.protocol,f.inventory,f.artifact,{},runtime);
test('explicit R2 compatibility view preserves source objects, late denominator and unavailable rows',()=>{
 const f=adapted(),before=JSON.stringify(f),r=run(f);assert.equal(JSON.stringify(f),before);assert.equal(f.dataset.protocolFingerprint,'R2');
 assert.equal(r.plannedDenominator,2);assert.equal(r.rows[0].matchId,'9007199254740993');assert.equal(r.rows[1].predictions.M0,null);
});
test('parent, vocabulary, ledger, parity and fitting-policy drift fail before scoring',()=>{
 for(const mutate of [f=>f.dataset.r1ProtocolFingerprint='wrong',f=>f.plan.fingerprint='wrong',f=>f.dataset.heroVocabulary=[99],f=>f.plan.targetLedger.mapIds.pop(),f=>f.dataset.earlyParity.train.status='failed',f=>f.plan.parameters.calibrationFittingAllowed=true,f=>f.dataset.policy={changed:true}]){
  const f=adapted();mutate(f);assert.throws(()=>run(f));
 }
});
test('new history affects scores while changed target labels cannot affect inference',()=>{
 const f=adapted(),before=run(f);f.dataset.labels[0].teamAWon=false;
 assert.deepEqual(run(f).rows.map(r=>r.predictions),before.rows.map(r=>r.predictions));
 f.dataset.rows[1].inputs={...f.dataset.rows[1].inputs,eloLogit:.9};assert.notEqual(run(f).rows[0].predictions.M0.probability,before.rows[0].predictions.M0.probability);
});
test('unavailable calibrated model remains null, never substituted by raw score',()=>{
 const f=adapted();f.artifact.models.M2={status:'unavailable'};const r=run(f);assert.equal(r.rows[0].predictions.M2_cal,null);assert(r.rows[0].reasons.includes('M2_MODEL_UNAVAILABLE'));assert.equal(r.rows.length,2);
});
