import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {prepareFitInput,checkParity} from '../../tools/research/post-draft-fit.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const inputs={eloLogit:1,signedHeroes:Array.from({length:10},(_,i)=>({heroId:i+1,value:i<5?1:-1}))};
test('training transfer omits late examples and labels, and refuses synthetic/invalid source',()=>{
 const row=(matchId,partition)=>({matchId,partition,seriesKey:'s'+matchId,pairedEligible:true,baselineEligible:true,reasons:[],featureSnapshot:{cutoffAtUs:'1'},inputs});
 const data={format:'conditional-post-draft-dataset-v1',deployable:false,syntheticOnly:false,rows:[row('1','train'),row('2','development_test')],labels:[{matchId:'1',teamAWon:true},{matchId:'2',teamAWon:false}],policy:{},heroVocabulary:[],dataChecks:{status:'insufficient'}};
 const transferred=prepareFitInput(data,'a'.repeat(64));assert.equal(transferred.rows.length,1);assert.equal(transferred.rows[0].matchId,'1');
 data.labels[1].teamAWon=true;assert.deepEqual(prepareFitInput(data,'a'.repeat(64)),transferred);
 data.syntheticOnly=true;assert.throws(()=>prepareFitInput(data,'a'.repeat(64)));data.syntheticOnly=false;
 data.labels.push(data.labels[0]);assert.throws(()=>prepareFitInput(data,'a'.repeat(64)),/duplicate/);
});
test('strict TypeScript inference validates order/unknowns, extremes and side swaps',async t=>{
 const parent=resolve(tmpdir()),dir=await mkdtemp(join(parent,'dota-draft-inference-'));
 t.after(async()=>{assert(dir.startsWith(parent+sep)&&dir.includes('dota-draft-inference-'));await rm(dir,{recursive:true});});
 const r=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','tools/research/post-draft-inference.mts','--strict','--noUncheckedIndexedAccess','--skipLibCheck','--target','ES2022','--module','NodeNext','--outDir',dir],{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);
 const runtime=await import(pathToFileURL(join(dir,'post-draft-inference.mjs')).href),vocab=Array.from({length:10},(_,i)=>i+1);
 const model={status:'fitted',featureOrder:['eloLogit',...vocab.map(h=>'hero:'+h)],coefficients:[.8,...vocab.map(()=>.1)],intercept:0,calibration:{status:'fitted',temperature:1.2}};
 const result=runtime.infer(model,'M2',inputs,vocab),swapped={eloLogit:-inputs.eloLogit,signedHeroes:inputs.signedHeroes.map(h=>({...h,value:-h.value}))};
 assert(Math.abs(result.calibratedProbability+runtime.infer(model,'M2',swapped,vocab).calibratedProbability-1)<1e-12);
 for(const value of [-1000,1000])assert(Number.isFinite(runtime.sigmoid(value)));
 assert.throws(()=>runtime.sigmoid(NaN));assert.throws(()=>runtime.encode({...inputs,eloLogit:Infinity},vocab));
 assert.throws(()=>runtime.encode({...inputs,signedHeroes:[...inputs.signedHeroes.slice(1),{heroId:99,value:1}]},vocab));
 assert.throws(()=>runtime.infer({...model,featureOrder:[...model.featureOrder].reverse()},'M2',inputs,vocab));
 assert.throws(()=>runtime.infer({...model,calibration:{status:'fitted',temperature:.25}},'M2',inputs,vocab));
 assert.equal(runtime.infer({...model,calibration:{status:'insufficient',temperature:.25}},'M2',inputs,vocab).calibratedProbability,null);
 const goldenPath=process.env.DOTA_SYNTHETIC_PARITY_OUTPUT;
 if(goldenPath){const artifact=JSON.parse(await readFile(goldenPath,'utf8'));const report=checkParity(artifact,runtime);assert.equal(report.status,'PASS');assert(report.vectorsPerModel.M2>=100);
  artifact.models.M2.coefficients[0]+=1;assert.throws(()=>checkParity(artifact,runtime),/parity/);}
});
