/** Immutable local numerical harness; real bundles remain unregistered and unscored. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat,realpath,mkdtemp,rm} from 'node:fs/promises';
import {resolve,relative,join,dirname,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {checkPlayerHeroParity} from './player-hero-fit.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const python=join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
const threads={OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1',NUMEXPR_NUM_THREADS:'1',PYTHONHASHSEED:'42'};
const policyPath='tools/research/player-hero-conditional-future-policy.json',policySha='77fa352544f4938e8b1cd69a2772894cff6b34df4b954e97677d36ea10ce388f';
const Time=z.string().datetime({offset:false}),Schedule=z.object({registeredAt:Time.nullable(),from:Time,until:Time,assessmentAt:Time,assessedAt:Time}).strict();
const Spec=z.object({format:z.literal('conditional-evaluator-files-input-v1'),bundle:z.object({directory:z.string().min(1).max(1024),
 manifestSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),schedule:Schedule.nullable()}).strict();
const runtimePath='.tools/s304-conditional-score-runtime/player-hero-inference.mjs';
const codePaths=[policyPath,'tools/research/conditional-evaluator.mjs','tools/research/conditional_future_evaluate.py',
 'tools/research/player-hero-inference.mts','tools/research/player-hero-fit.mjs','tools/research/player_hero_fit.py',
 'tools/research/player-hero-experiment-plan.mjs','tools/research/post-draft-dataset.mjs',
 'tools/research/player_hero_evaluate.py','tools/research/post_draft_evaluate.py','tools/research/post_draft_independent_evaluate.py',
 'tools/research/post_draft_fit.py','tools/research/player-hero-experiment-policy.json','tools/research/post-draft-policy.json',runtimePath];
const execute=(cmd,args)=>{const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8',env:{...process.env,...threads},timeout:180000,maxBuffer:16*1024*1024});
 assert.equal(r.status,0,'subprocess_failed');return r.stdout;};
async function privatePath(path,existing=true){
 const full=resolve(root,path),base=await realpath(join(root,'.tools'));
 const checked=existing?await realpath(full):join(await realpath(dirname(full)),basename(full));
 const rel=relative(base,checked);assert(rel&&!rel.startsWith('..')&&!rel.includes(':'),'private_path_required');return full;
}
async function bytes(path){const p=await privatePath(path),s=await stat(p);assert(s.isFile()&&s.size<=16*1024*1024,'bounded_file_required');return readFile(p);}
async function pinned(path,expected){const b=await bytes(path);assert.equal(sha(b),expected,'pinned_source_changed');return JSON.parse(b);}
function tsScores(artifact,inputs,runtime){
 const values=runtime.encode(inputs),p={H0:{logit:values[0],probability:runtime.sigmoid(values[0])}};
 for(const name of ['H1','H2']){
  const model=artifact.models[name];if(model.status!=='fitted'){p[name+'_raw']=null;p[name+'_cal']=null;continue;}
  const result=runtime.infer(model,name,inputs),xs=name==='H1'?values.slice(0,1):values;
  const logit=xs.reduce((sum,x,i)=>sum+x*model.coefficients[i],0);
  p[name+'_raw']={logit,probability:result.rawProbability};
  p[name+'_cal']=result.calibratedProbability===null?null:{logit:logit/model.calibration.temperature,probability:result.calibratedProbability};
 }
 return p;
}
function compare(expected,actual){
 let maximum=0,comparisons=0;assert.equal(actual.length,expected.length,'parity_vectors');
 for(let i=0;i<expected.length;i++)for(const name of Object.keys(expected[i])){
  const a=actual[i][name],b=expected[i][name];if(a===null||b===null){assert.equal(a,b,'parity_null');continue;}
  for(const key of ['logit','probability']){const delta=Math.abs(a[key]-b[key]);assert(Number.isFinite(delta)&&delta<=1e-12,'python_TS_parity');maximum=Math.max(maximum,delta);comparisons++;}
 }
 return {comparisons,maxAbsoluteError:maximum,tolerance:1e-12};
}
async function compute(spec){
 const directory=await privatePath(spec.bundle.directory),parent=await pinned(join(directory,'manifest.json'),spec.bundle.manifestSha256);
 execute(process.execPath,['tools/research/conditional-evaluation-files.mjs','verify',directory,spec.bundle.manifestSha256]);
 const bundle={};for(const name of ['cohort','features','labels'])bundle[name]=await pinned(join(directory,name+'.json'),parent.artifacts[name+'.json']);
 const policyBytes=await readFile(join(root,policyPath));assert.equal(sha(policyBytes),policySha,'policy_changed');const policy=JSON.parse(policyBytes);
 const artifact=await pinned(policy.candidate.artifactPath,policy.candidate.artifactSha256);
 execute(process.execPath,['node_modules/typescript/bin/tsc','tools/research/player-hero-inference.mts','--strict','--noUncheckedIndexedAccess',
  '--skipLibCheck','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--outDir','.tools/s304-conditional-score-runtime']);
 const runtime=await import(pathToFileURL(join(root,runtimePath)).href),goldens=checkPlayerHeroParity(artifact,runtime);
 const scratch=await mkdtemp(join(root,'.tools/conditional-evaluator-'));
 try{
  const vectors=artifact.goldens.map(g=>g.inputs),parityPath=join(scratch,'parity.json');
  await writeFile(parityPath,JSON.stringify({artifact,vectors}));
  const pythonScores=JSON.parse(execute(python,['tools/research/conditional_future_evaluate.py','infer',parityPath]));
  const parity={goldens,currentPython:compare(vectors.map(v=>tsScores(artifact,v,runtime)),pythonScores)};
  const input={bundle,artifact,schedule:spec.schedule},inputText=JSON.stringify(input,null,2)+'\n',path=join(scratch,'input.json');
  await writeFile(path,inputText);
  const report=JSON.parse(execute(python,['tools/research/conditional_future_evaluate.py','evaluate',path]));
  if(!bundle.cohort.syntheticOnly)assert.equal(report.scoringPerformed,false,'real_scoring_forbidden');
  const scored=report.ledger.filter(r=>r.predictions.H0!==null);
  if(scored.length){const byId=new Map(bundle.features.rows.map(r=>[r.matchId,r.inputs]));
   parity.bundleRows=compare(scored.map(r=>tsScores(artifact,byId.get(r.matchId),runtime)),scored.map(r=>r.predictions));}
  const pythonEnvironment=JSON.parse(execute(python,['tools/research/conditional_future_evaluate.py','environment']));
  return {inputText,report,parity,pythonEnvironment,policy,parent};
 }finally{
  await privatePath(scratch);await rm(scratch,{recursive:true,force:true});
 }
}
async function main(){
 const [mode,...args]=process.argv.slice(2);assert(mode==='build'?args.length===3:mode==='verify'&&args.length===2,'arguments');
 let directory,ref,saved;
 if(mode==='build'){
  const [path,hash,out]=args;assert(/^[a-f0-9]{64}$/.test(hash),'expected_hash_required');
  directory=await privatePath(out,false);ref={path:relative(root,await privatePath(path)),sha256:hash};
 }else{directory=await privatePath(args[0]);saved=await pinned(join(directory,'manifest.json'),args[1]);ref=saved.input;}
 const spec=Spec.parse(await pinned(ref.path,ref.sha256)),result=await compute(spec);
 const outputs={'input.json':result.inputText,'report.json':JSON.stringify(result.report,null,2)+'\n','parity.json':JSON.stringify(result.parity,null,2)+'\n'};
 const manifest={format:'conditional-evaluator-files-v1',node:process.version,pythonEnvironment:result.pythonEnvironment,threads,input:ref,parent:spec.bundle,
  policySha256:policySha,candidateSha256:result.policy.candidate.artifactSha256,
  code:Object.fromEntries(await Promise.all(codePaths.map(async p=>[p,sha(await readFile(join(root,p)))]))),
  artifacts:Object.fromEntries(Object.entries(outputs).map(([file,body])=>[file,sha(body)])),
  syntheticOnly:result.report.syntheticOnly,realEvaluationAllowed:false,registrationAllowed:false,collectionAllowed:false,deployable:false};
 const text=JSON.stringify(manifest,null,2)+'\n';
 if(mode==='build'){
  await mkdir(directory);for(const [file,body] of Object.entries(outputs))await writeFile(join(directory,file),body,{flag:'wx'});
  await writeFile(join(directory,'manifest.json'),text,{flag:'wx'});
 }else{
  assert.deepEqual(saved,manifest,'manifest_replay_mismatch');for(const [file,body] of Object.entries(outputs))assert.equal((await bytes(join(directory,file))).toString('utf8'),body,'output_replay_mismatch');
 }
 console.log(JSON.stringify({status:mode==='build'?'conditional_evaluation_saved':'conditional_evaluation_verified',manifestSha256:sha(text),
  syntheticOnly:manifest.syntheticOnly,result:result.report.status,scoringPerformed:result.report.scoringPerformed,
  counts:result.report.counts,parity:result.parity,deployable:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
 console.error(error.code==='EEXIST'?'Каталог уже существует; используйте verify или новый путь.':
  'Оценка отклонена: проверьте SHA, исходный набор, сроки, Python-окружение и численную совместимость.');process.exitCode=1;
});
