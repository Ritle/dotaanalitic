import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,relative,join,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {boundedJson,digest,sha} from './post-draft-dataset.mjs';
import {experimentPolicy} from './player-hero-experiment-plan.mjs';
const {z}=createRequire(new URL('../../packages/contracts/package.json',import.meta.url))('zod');
const root=fileURLToPath(new URL('../../',import.meta.url));
const python=join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
const threads={OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1',NUMEXPR_NUM_THREADS:'1',PYTHONHASHSEED:'42'};
const splits=['train','validation','calibration'],policy=experimentPolicy();
const Hash=z.string().regex(/^[a-f0-9]{64}$/),Id=z.string().regex(/^[1-9]\d{0,18}$/);
const Inputs=z.object({eloLogit:z.number().finite(),observedHeroPracticeLog90Delta:z.number().finite()}).strict();
const Row=z.object({matchId:Id,seriesKey:z.string().min(1),split:z.enum(splits),cutoffAtUs:z.string().regex(/^\d+$/),inputs:Inputs,label:z.boolean(),
 labelCompletedAtUs:z.string().regex(/^\d+$/),labelVerifiedAtUs:z.string().regex(/^\d+$/),receiptSha256:Hash}).strict();
const Probability=z.object({rawProbability:z.number().min(0).max(1),calibratedProbability:z.number().min(0).max(1).nullable()}).strict();
const Candidate=z.discriminatedUnion('status',[
 z.object({status:z.literal('valid'),C:z.number().positive(),validationLogLoss:z.number().finite().nonnegative(),iterations:z.number().int().positive()}).strict(),
 z.object({status:z.literal('invalid'),C:z.number().positive(),reason:z.string()}).strict()]);
const Model=z.discriminatedUnion('status',[
 z.object({status:z.literal('unavailable'),reason:z.literal('NO_CONVERGED_CANDIDATE'),candidates:z.array(Candidate).length(3)}).strict(),
 z.object({status:z.literal('fitted'),selectedC:z.number().positive(),candidates:z.array(Candidate).length(3),featureOrder:z.array(z.string()).min(1).max(2),
  coefficients:z.array(z.number().finite()).min(1).max(2),intercept:z.literal(0),calibration:z.object({status:z.enum(['fitted','insufficient']),temperature:z.number().finite().nullable(),
   reason:z.string().nullable(),calibrationLogLoss:z.number().finite().nonnegative().nullable(),bounds:z.tuple([z.literal(.25),z.literal(4)])}).strict()}).strict()]);
const Artifact=z.object({format:z.literal('player-hero-research-fit-v1'),models:z.object({H1:Model,H2:Model}).strict(),seed:z.literal(42),intercept:z.literal(false),
 preprocessing:z.literal('identity'),featureOrder:z.tuple([z.literal('eloLogit'),z.literal('observedHeroPracticeLog90Delta')]),
 counts:z.object({train:z.number().int(),validation:z.number().int(),calibration:z.number().int()}).strict(),developmentTestConsumed:z.literal(false),qualityGate:z.literal('not_evaluated'),
 syntheticOnly:z.boolean(),deployable:z.literal(false),manifestSha256:Hash,fitInputSha256:Hash,datasetSha256:Hash,labelsSha256:Hash,protocolFingerprint:Hash,selectedSha256:Hash,
 goldens:z.array(z.object({case:z.enum(policy.environment.parityCases),annotations:z.array(z.string()),inputs:Inputs,
  expected:z.object({H0:Probability,H1:Probability.optional(),H2:Probability.optional()}).strict()}).strict()).min(100).max(3000)}).strict();
const execute=(cmd,args)=>{const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8',env:{...process.env,...threads},maxBuffer:2*1024*1024});assert.equal(r.status,0,'subprocess_failed');return r.stdout;};
const local=p=>relative(root,p).split(sep).join('/');
const immutable=(p,v)=>writeFile(p,JSON.stringify(v)+'\n',{flag:'wx'});
const us=t=>{assert(Number.isFinite(Date.parse(t)));return (BigInt(Date.parse(t))*1000n).toString();};
const index=rows=>{const m=new Map(rows.map(r=>[r.matchId,r]));assert.equal(m.size,rows.length,'duplicate_map');return m;};

/** Projection deliberately ignores all late inputs and outcomes. Labels join by canonical match ID. */
export function preparePlayerHeroFitInput(dataset,labels,datasetSha256,labelsSha256){
 assert.equal(dataset.format,'player-hero-experiment-dataset-v1');assert.equal(dataset.syntheticOnly,false);assert.equal(dataset.deployable,false);
 assert.equal(labels.format,'player-hero-experiment-labels-v1');assert.equal(labels.deployable,false);
 assert.deepEqual(dataset.featureOrder,policy.models.H2.features);index(dataset.rows);const byId=index(labels.rows);
 const rows=dataset.rows.filter(r=>r.pairedEligible&&splits.includes(r.nominalWindow)).map(r=>{
  assert(r.originalPairedEligible&&r.baselineEligible&&!r.reasons.length,'invalid_paired_row');
  const l=byId.get(r.matchId);assert(l,'missing_label');
  return Row.parse({matchId:r.matchId,seriesKey:r.seriesKey,split:r.nominalWindow,cutoffAtUs:us(r.startedAt),inputs:r.inputs,label:l.teamAWon,
   labelCompletedAtUs:us(l.completedAt),labelVerifiedAtUs:us(l.verifiedAt),receiptSha256:l.sourceEvidence.payloadSha256});
 });
 const groups=new Map();for(const r of rows){assert(!groups.has(r.seriesKey)||groups.get(r.seriesKey)===r.split,'series_crosses_split');groups.set(r.seriesKey,r.split);}
 return {format:'player-hero-fit-input-v1',protocolFingerprint:Hash.parse(dataset.protocolFingerprint),datasetSha256:Hash.parse(datasetSha256),
  labelsSha256:Hash.parse(labelsSha256),policy:experimentPolicy(),rows,syntheticOnly:false};
}

export function checkPlayerHeroParity(raw,runtime){
 const a=Artifact.parse(raw),cases=new Set(),counts={H0:0,H1:0,H2:0};let comparisons=0,maximum=0;
 for(const g of a.goldens){
  cases.add(g.case);runtime.encode(g.inputs);
  const names=['H0',...['H1','H2'].filter(n=>a.models[n].status==='fitted')];assert.deepEqual(Object.keys(g.expected).sort(),names.sort(),'missing_parity_model');
  for(const n of names){
   let actual;
   if(n==='H0'){const p=runtime.sigmoid(g.inputs.eloLogit);actual={rawProbability:p,calibratedProbability:p};}
   else {const model=structuredClone(a.models[n]);if(g.case==='calibrator_unavailable')model.calibration={status:'insufficient',temperature:null};actual=runtime.infer(model,n,g.inputs);}
   for(const k of ['rawProbability','calibratedProbability']){
    const expected=g.expected[n][k];if(actual[k]===null||expected===null){assert.equal(actual[k],expected,'calibration_parity');continue;}
    const error=Math.abs(actual[k]-expected);assert(Number.isFinite(error)&&error<=policy.environment.parityTolerance,'probability_parity');
    maximum=Math.max(maximum,error);comparisons++;
   }
   counts[n]++;
  }
 }
 assert.deepEqual([...cases].sort(),[...policy.environment.parityCases].sort(),'missing_parity_cases');
 for(const n of ['H0','H1','H2'])if(n==='H0'||a.models[n].status==='fitted')assert(counts[n]>=100,'parity_floor');
 return {status:'PASS',maxAbsoluteError:maximum,tolerance:policy.environment.parityTolerance,comparisons,vectorsPerModel:counts,cases:[...cases].sort()};
}

const datasetDirectory='.tools/s304-hero-dataset-r1',evidencePath='docs/evidence/s3-04-player-hero-experiment-dataset.json',planPath='docs/evidence/s3-04-player-hero-experiment-plan.json';
async function sources(){
 const evidence=await boundedJson(join(root,evidencePath)),plan=await boundedJson(join(root,planPath)),loaded={};
 for(const [name,hash] of Object.entries(evidence.value.artifacts)){
  const path=join(root,datasetDirectory,name);loaded[name]=await boundedJson(path);assert.equal(loaded[name].sha256,hash,'dataset_evidence_sha');
 }
 const d=loaded['dataset.json'],l=loaded['labels.json'],m=loaded['manifest.json'];
 assert.equal(evidence.value.directory,datasetDirectory);assert.equal(m.value.directory,datasetDirectory);
 for(const ref of Object.values(m.value.inputs))assert.equal(sha(await readFile(join(root,ref.path))),ref.sha256,'frozen_source_changed');
 for(const [p,h] of Object.entries(plan.value.code))assert.equal(sha(await readFile(join(root,p))),h,'registered_plan_code_changed');
 assert.equal(m.value.inputs.plan.sha256,plan.sha256);assert.deepEqual(plan.value.policy,policy);
 assert.equal(d.value.protocolFingerprint,plan.value.fingerprint);assert.equal(d.value.artifacts.labels.sha256,l.sha256);
 for(const entry of [d,l,loaded['features.json'],plan]){const {fingerprint,...body}=entry.value;assert.equal(digest(body),fingerprint);}
 for(const [p,h] of Object.entries(m.value.code))assert.equal(sha(await readFile(join(root,p))),h,'dataset_code_changed');
 return {input:preparePlayerHeroFitInput(d.value,l.value,d.sha256,l.sha256),sources:{evidence:{path:evidencePath,sha256:evidence.sha256},
  plan:{path:planPath,sha256:plan.sha256},...Object.fromEntries(Object.entries(loaded).map(([k,v])=>[k,{path:datasetDirectory+'/'+k,sha256:v.sha256}]))}};
}
function environment(){
 const e={pythonEnvironment:JSON.parse(execute(python,['tools/research/player_hero_fit.py','environment'])),node:process.version,threads};
 const packages=new Map(e.pythonEnvironment.packages.map(p=>[p.name.toLowerCase(),p.version]));
 for(const [name,version] of [['scikit-learn','1.8.0'],['numpy','2.3.5'],['scipy','1.17.0'],['joblib','1.5.3'],['threadpoolctl','3.6.0']])assert.equal(packages.get(name),version,'environment_version');
 assert(/^3\.(11|12|13)\./.test(e.pythonEnvironment.python));return e;
}
async function code(directory){
 const paths=['tools/research/player-hero-fit.mjs','tools/research/player_hero_fit.py','tools/research/player-hero-inference.mts',
  'tools/research/player-hero-experiment-policy.json','tools/research/post_draft_fit.py','tools/ml/requirements-ci.txt',
  'tests/node/player-hero-fit.test.mjs','tests/research/test_player_hero_fit.py','package.json','pnpm-lock.yaml',
  'node_modules/typescript/lib/typescript.js','node_modules/typescript/lib/_tsc.js',local(join(directory,'compiled/player-hero-inference.mjs'))];
 return Promise.all(paths.sort().map(async path=>({path,sha256:sha(await readFile(join(root,path)))})));
}
async function register(directory){
 execute(process.execPath,['tools/research/player-hero-experiment-dataset.mjs','verify',datasetDirectory]);
 const s=await sources(),env=environment();
 await mkdir(directory);await mkdir(join(directory,'compiled'));
 const compilerArgs=['node_modules/typescript/bin/tsc','tools/research/player-hero-inference.mts','--strict','--noUncheckedIndexedAccess','--skipLibCheck',
  '--target','ES2022','--module','NodeNext','--outDir',local(join(directory,'compiled'))];
 execute(process.execPath,compilerArgs);await immutable(join(directory,'fit-input.json'),s.input);
 const manifest={format:'player-hero-fit-manifest-v1',registeredAt:new Date().toISOString(),directory:local(directory),environment:env,code:await code(directory),compilerArgs,
  sources:s.sources,fitInputSha256:sha(await readFile(join(directory,'fit-input.json'))),policy,developmentTestConsumed:false,deployable:false};
 await immutable(join(directory,'manifest.json'),manifest);
 return {status:'registered_before_fit',counts:Object.fromEntries(splits.map(k=>[k,s.input.rows.filter(r=>r.split===k).length])),developmentTestConsumed:false,deployable:false};
}
async function checked(directory){
 const manifest=await boundedJson(join(directory,'manifest.json')),m=manifest.value,s=await sources(),input=await boundedJson(join(directory,'fit-input.json'));
 assert.equal(m.format,'player-hero-fit-manifest-v1');assert.equal(m.directory,local(directory));assert.equal(m.deployable,false);assert.equal(m.developmentTestConsumed,false);
 assert.deepEqual(m.policy,policy);assert.deepEqual(m.sources,s.sources);assert.deepEqual(m.environment,environment());assert.deepEqual(m.code,await code(directory));
 assert.deepEqual(input.value,s.input,'input_projection_changed');assert.equal(input.sha256,m.fitInputSha256);assert(m.registeredAt<=new Date().toISOString());
 return {manifest,input};
}
async function verify(directory,persist=false){
 const {manifest,input}=await checked(directory),started=(await boundedJson(join(directory,'started.json'))).value;
 assert.equal(started.manifestSha256,manifest.sha256);assert(started.startedAt>=manifest.value.registeredAt&&started.startedAt<=new Date().toISOString());
 execute(python,['tools/research/player_hero_fit.py','verify',local(directory)]);
 const artifact=await boundedJson(join(directory,'artifact.json')),a=Artifact.parse(artifact.value);
 assert.equal(a.manifestSha256,manifest.sha256);assert.equal(a.fitInputSha256,input.sha256);assert.equal(a.datasetSha256,input.value.datasetSha256);
 assert.equal(a.labelsSha256,input.value.labelsSha256);assert.equal(a.protocolFingerprint,input.value.protocolFingerprint);assert.equal(a.syntheticOnly,false);
 assert.equal(a.selectedSha256,sha(await readFile(join(directory,'selected.json'))));
 assert.deepEqual(a.counts,Object.fromEntries(splits.map(k=>[k,input.value.rows.filter(r=>r.split===k).length])));
 const parity=checkPlayerHeroParity(a,await import(pathToFileURL(join(directory,'compiled/player-hero-inference.mjs')).href));
 const result={status:'completed_research_only',manifestSha256:manifest.sha256,artifactSha256:artifact.sha256,selectedSha256:a.selectedSha256,counts:a.counts,parity,
  models:Object.fromEntries(Object.entries(a.models).map(([n,m])=>[n,m.status==='fitted'?{status:m.status,selectedC:m.selectedC,coefficients:m.coefficients,calibration:m.calibration}:{status:m.status,reason:m.reason}])),
  developmentTestConsumed:false,qualityGate:'not_evaluated',deployable:false};
 if(persist)await immutable(join(directory,'result.json'),result);else assert.deepEqual((await boundedJson(join(directory,'result.json'))).value,result,'result_replay');
 return result;
}
async function main(){
 const [mode,path,...extra]=process.argv.slice(2);assert(['register','run','verify'].includes(mode)&&path&&!extra.length);
 const directory=resolve(root,path),rel=relative(join(root,'.tools'),directory);assert(rel&&!rel.startsWith('..')&&!rel.includes(':'));
 if(mode==='register'){console.log(JSON.stringify(await register(directory)));return;}
 if(mode==='run'){
  const {manifest}=await checked(directory);await immutable(join(directory,'started.json'),{manifestSha256:manifest.sha256,startedAt:new Date().toISOString()});
  try{execute(python,['tools/research/player_hero_fit.py','fit',local(directory)]);console.log(JSON.stringify(await verify(directory,true)));}
  catch(e){await immutable(join(directory,'failed.json'),{status:'FIT_OR_PARITY_FAILED',manifestSha256:manifest.sha256,deployable:false});throw e;}
 }else console.log(JSON.stringify(await verify(directory)));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{
 console.error(e.code==='EEXIST'?'Run уже существует; нужна отдельная версия.':'Обучение отклонено: проверьте протокол, SHA, окружение и независимость блоков.');process.exitCode=1;
});
