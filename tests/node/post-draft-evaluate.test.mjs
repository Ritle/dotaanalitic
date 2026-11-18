import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareEvaluationInput} from '../../tools/research/post-draft-evaluate.mjs';
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
const run=f=>prepareEvaluationInput(f.dataset,f.inventory,f.protocol,f.artifact,{},runtime);
test('evaluation selects only late targets and preserves full denominator, bigint IDs and unknown patch',()=>{
 const f=fixture(),before=JSON.stringify(f),r=run(f);assert.equal(JSON.stringify(f),before);
 assert.equal(r.rows.length,2);assert.equal(r.plannedDenominator,2);assert.equal(r.rows[0].matchId,'9007199254740993');
 assert.equal(r.rows[0].annotations.canonicalPatchId,null);assert.equal(r.rows[1].predictions.M0,null);assert.equal(r.rows[1].label,null);
 assert.deepEqual(r.upstreamDataChecks,f.dataset.dataChecks);
});
test('changing evaluation labels never changes frozen-model predictions',()=>{
 const f=fixture(),before=run(f);f.dataset.labels[0].teamAWon=false;const after=run(f);
 assert.deepEqual(after.rows.map(r=>r.predictions),before.rows.map(r=>r.predictions));assert.notEqual(after.rows[0].label,before.rows[0].label);
});
test('missing model remains null without raw-to-calibrated fallback or record removal',()=>{
 const f=fixture();f.artifact.models.M2={status:'unavailable'};const result=run(f);
 assert.equal(result.rows.length,2);assert.equal(result.rows[0].predictions.M2_cal,null);assert(result.rows[0].reasons.includes('M2_MODEL_UNAVAILABLE'));
});
test('changed denominator, missing verified label and duplicate metadata are rejected',()=>{
 for(const mutate of [f=>f.protocol.partitions.development_test.plannedDenominator=1,f=>f.dataset.labels=[],f=>f.inventory.maps.push(f.inventory.maps[0])]){const f=fixture();mutate(f);assert.throws(()=>run(f));}
});
