import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,relative,sep,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {boundedJson,digest,sha} from './post-draft-dataset.mjs';
const {z}=createRequire(new URL('../../packages/contracts/package.json',import.meta.url))('zod');
const root=fileURLToPath(new URL('../../',import.meta.url));
const python=join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
const threads={OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1',NUMEXPR_NUM_THREADS:'1',PYTHONHASHSEED:'42'};
const hashSchema=z.string().regex(/^[a-f0-9]{64}$/);
const Config=z.object({inventory:z.string(),metadata:z.string(),protocol:z.string(),capture:z.string(),dataset:z.string(),
 expectedDatasetSha256:hashSchema,expectedProtocolSha256:hashSchema}).strict();
const inputsSchema=z.object({eloLogit:z.number().finite(),signedHeroes:z.array(z.object({heroId:z.number().int().positive(),value:z.union([z.literal(1),z.literal(-1)])}).strict()).length(10)}).strict();
const resultSchema=z.object({rawProbability:z.number().min(0).max(1),calibratedProbability:z.number().min(0).max(1).nullable()}).strict();
const candidate=z.discriminatedUnion('status',[
 z.object({C:z.number().positive(),status:z.literal('valid'),validationLogLoss:z.number().finite().nonnegative(),iterations:z.number().int().positive()}).strict(),
 z.object({C:z.number().positive(),status:z.literal('invalid'),reason:z.string()}).strict()]);
const model=z.discriminatedUnion('status',[
 z.object({status:z.literal('unavailable'),reason:z.literal('NO_CONVERGED_CANDIDATE'),candidates:z.array(candidate).length(3)}).strict(),
 z.object({status:z.literal('fitted'),selectedC:z.number().positive(),candidates:z.array(candidate).length(3),featureOrder:z.array(z.string()).min(1).max(1024),
  coefficients:z.array(z.number().finite()).min(1).max(1024),intercept:z.literal(0),calibration:z.object({status:z.enum(['fitted','insufficient']),
   temperature:z.number().finite().nullable(),reason:z.string().nullable(),calibrationLogLoss:z.number().finite().nonnegative().nullable(),bounds:z.tuple([z.literal(0.25),z.literal(4)])}).strict()}).strict()]);
const artifactSchema=z.object({format:z.literal('conditional-logistic-research-fit-v1'),models:z.object({M1:model,M2:model}).strict(),
 heroVocabulary:z.array(z.number().int().positive()).max(1024),seed:z.literal(42),intercept:z.literal(false),preprocessing:z.literal('none'),
 counts:z.object({train:z.number().int(),validation:z.number().int(),calibration:z.number().int()}).strict(),dataChecks:z.unknown(),developmentTestConsumed:z.literal(false),
 qualityGate:z.literal('not_evaluated'),syntheticOnly:z.boolean(),deployable:z.literal(false),
 goldens:z.array(z.object({inputs:inputsSchema,expected:z.object({M0:resultSchema,M1:resultSchema.optional(),M2:resultSchema.optional()}).strict()}).strict()).min(100).max(3000),
 manifestSha256:hashSchema,fitInputSha256:hashSchema,datasetSha256:hashSchema,protocolFingerprint:hashSchema}).strict();
const execute=(command,args)=>{const r=spawnSync(command,args,{cwd:root,encoding:'utf8',env:{...process.env,...threads},maxBuffer:2*1024*1024});if(r.status!==0)throw Error('subprocess_failed');return r.stdout;};
const safePath=path=>{const p=resolve(root,path),r=relative(root,p);if(!r||r.startsWith('..')||r.includes(':'))throw Error('path_outside_workspace');return p;};
const local=path=>relative(root,path).split(sep).join('/');
const immutable=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
function env(){return {pythonEnvironment:JSON.parse(execute(python,['tools/research/post_draft_fit.py','environment'])),node:process.version,
 typescript:JSON.parse(execute(process.execPath,['-p','JSON.stringify(require("typescript/package.json").version)'])),threads};}
function assertEnvironment(environment){
 const packages=new Map(environment.pythonEnvironment.packages.map(p=>[p.name.toLowerCase(),p.version]));
 for(const [name,version] of [['scikit-learn','1.8.0'],['numpy','2.3.5'],['scipy','1.17.0'],['joblib','1.5.3'],['threadpoolctl','3.6.0']])if(packages.get(name)!==version)throw Error('environment_version');
 if(!/^3\.(11|12|13)\./.test(environment.pythonEnvironment.python))throw Error('python_version');
}
async function code(compiled){
 const paths=['tools/research/post-draft-fit.mjs','tools/research/post_draft_fit.py','tools/research/post-draft-inference.mts',
  'tools/research/post-draft-policy.json','tools/ml/requirements-ci.txt','tests/node/post-draft-fit.test.mjs','tests/research/test_post_draft_fit.py',
  'package.json','pnpm-lock.yaml',local(compiled)];
 return Promise.all(paths.sort().map(async path=>({path,sha256:sha(await readFile(safePath(path)))})));
}
export function prepareFitInput(dataset,datasetSha256){
 if(dataset.format!=='conditional-post-draft-dataset-v1'||dataset.deployable!==false||dataset.syntheticOnly!==false)throw Error('research_dataset_required');
 const labels=new Map(dataset.labels.map(l=>[l.matchId,l]));if(labels.size!==dataset.labels.length)throw Error('duplicate_labels');
 const rows=dataset.rows.filter(r=>r.pairedEligible&&['train','validation','calibration'].includes(r.partition)).map(r=>{
  const label=labels.get(r.matchId);if(!label||!r.baselineEligible||r.reasons.length||typeof label.teamAWon!=='boolean')throw Error('invalid_paired_row');
  return {matchId:r.matchId,seriesKey:r.seriesKey,split:r.partition,cutoffAtUs:r.featureSnapshot.cutoffAtUs,inputs:inputsSchema.parse(r.inputs),label:label.teamAWon};
 });
 return {format:'conditional-post-draft-fit-input-v1',datasetSha256,protocolFingerprint:dataset.protocolFingerprint,policy:dataset.policy,
  heroVocabulary:dataset.heroVocabulary,rows,dataChecks:dataset.dataChecks,syntheticOnly:false};
}
export function checkParity(artifactInput,runtime){
 const artifact=artifactSchema.parse(artifactInput),vocab=artifact.heroVocabulary;
 let maximum=0,comparisons=0;const counts={M0:0,M1:0,M2:0};
 for(const g of artifact.goldens){
  runtime.encode(g.inputs,vocab);
  const expectedNames=['M0',...['M1','M2'].filter(k=>artifact.models[k].status==='fitted')];
  if(Object.keys(g.expected).sort().join()!==expectedNames.sort().join())throw Error('missing_parity_model');
  for(const name of expectedNames){
   const actual=name==='M0'?{rawProbability:runtime.sigmoid(g.inputs.eloLogit),calibratedProbability:runtime.sigmoid(g.inputs.eloLogit)}:runtime.infer(artifact.models[name],name,g.inputs,vocab);
   for(const key of ['rawProbability','calibratedProbability']){
    if(actual[key]===null||g.expected[name][key]===null){if(actual[key]!==g.expected[name][key])throw Error('calibration_parity');continue;}
    const error=Math.abs(actual[key]-g.expected[name][key]);if(!Number.isFinite(error)||error>=1e-7)throw Error('probability_parity');maximum=Math.max(maximum,error);comparisons++;
   }
   counts[name]++;
  }
 }
 for(const [name,n] of Object.entries(counts))if((name==='M0'||artifact.models[name].status==='fitted')&&n<100)throw Error('parity_sample_floor');
 return {status:'PASS',maxAbsoluteError:maximum,tolerance:1e-7,comparisons,vectorsPerModel:counts};
}
async function checkedManifest(directory){
 const manifestPath=join(directory,'manifest.json'),m=await boundedJson(manifestPath,2*1024*1024),manifest=m.value;
 if(manifest.format!=='conditional-fit-manifest-v1'||manifest.deployable!==false||manifest.runDirectory!==local(directory)||manifest.compiled!==local(join(directory,'compiled/post-draft-inference.mjs')))throw Error('manifest_contract');
 const current=env();assertEnvironment(current);
 if(digest(current)!==digest(manifest.environment)||digest(await code(safePath(manifest.compiled)))!==digest(manifest.code))throw Error('executable_or_environment_changed');
 const input=await boundedJson(join(directory,'fit-input.json'),16*1024*1024);
 if(input.sha256!==manifest.fitInputSha256||input.value.datasetSha256!==manifest.config.expectedDatasetSha256)throw Error('input_changed');
 for(const [field,expected] of [['dataset',manifest.config.expectedDatasetSha256],['protocol',manifest.config.expectedProtocolSha256]])if((await boundedJson(safePath(manifest.config[field]))).sha256!==expected)throw Error('frozen_source_changed');
 return {manifest,manifestSha256:m.sha256,input:input.value,manifestPath};
}
async function register(configPath,directory){
 const config=Config.parse((await boundedJson(configPath,65536)).value);
 const [dataset,protocol]=await Promise.all([boundedJson(safePath(config.dataset)),boundedJson(safePath(config.protocol))]);
 if(dataset.sha256!==config.expectedDatasetSha256||protocol.sha256!==config.expectedProtocolSha256)throw Error('source_sha');
 // Full deterministic source/outcome/history replay is mandatory before executable registration.
 execute(process.execPath,['tools/research/freeze-post-draft.mjs','verify',...['inventory','metadata','protocol','capture','dataset'].map(k=>safePath(config[k]))]);
 const fitInput=prepareFitInput(dataset.value,dataset.sha256),environment=env();assertEnvironment(environment);
 await mkdir(directory);await mkdir(join(directory,'compiled'));
 execute(process.execPath,['node_modules/typescript/bin/tsc','tools/research/post-draft-inference.mts','--strict','--noUncheckedIndexedAccess','--skipLibCheck','--target','ES2022','--module','NodeNext','--outDir',join(directory,'compiled')]);
 const compiled=join(directory,'compiled/post-draft-inference.mjs');
 await immutable(join(directory,'fit-input.json'),fitInput);
 const manifest={format:'conditional-fit-manifest-v1',registeredAt:new Date().toISOString(),runDirectory:local(directory),config,
  fitInputSha256:sha(await readFile(join(directory,'fit-input.json'))),environment,pythonEnvironment:environment.pythonEnvironment,
  code:await code(compiled),compiled:local(compiled),seed:42,parityTolerance:1e-7,minimumParityVectors:100,deployable:false};
 await immutable(join(directory,'manifest.json'),manifest);
 return {status:'registered_before_fit',fitCounts:Object.fromEntries(['train','validation','calibration'].map(s=>[s,fitInput.rows.filter(r=>r.split===s).length])),developmentTestConsumed:false};
}
async function run(directory){
 const checked=await checkedManifest(directory),startedAt=new Date().toISOString();
 await immutable(join(directory,'started.json'),{manifestSha256:checked.manifestSha256,startedAt,deployable:false});
 try{
  execute(python,['tools/research/post_draft_fit.py','fit',join(directory,'fit-input.json'),checked.manifestPath,join(directory,'artifact.json')]);
  return await verify(directory,true);
 }catch(e){await immutable(join(directory,'failed.json'),{status:'failed',manifestSha256:checked.manifestSha256,reason:'FIT_OR_PARITY_FAILED',deployable:false});throw e;}
}
async function verify(directory,persist=false){
 const checked=await checkedManifest(directory),artifact=await boundedJson(join(directory,'artifact.json'),16*1024*1024);
 if(artifact.value.manifestSha256!==checked.manifestSha256||artifact.value.fitInputSha256!==checked.manifest.fitInputSha256||artifact.value.syntheticOnly!==false||
  artifact.value.datasetSha256!==checked.input.datasetSha256||artifact.value.protocolFingerprint!==checked.input.protocolFingerprint||
  digest(artifact.value.dataChecks)!==digest(checked.input.dataChecks)||digest(artifact.value.heroVocabulary)!==digest(checked.input.heroVocabulary))throw Error('artifact_binding');
 const counts=Object.fromEntries(['train','validation','calibration'].map(s=>[s,checked.input.rows.filter(r=>r.split===s).length]));
 if(digest(artifact.value.counts)!==digest(counts))throw Error('artifact_counts');
 const parity=checkParity(artifact.value,await import(pathToFileURL(safePath(checked.manifest.compiled)).href));
 const result={status:'completed_research_only',manifestSha256:checked.manifestSha256,artifactSha256:artifact.sha256,parity,
  models:Object.fromEntries(Object.entries(artifact.value.models).map(([name,m])=>[name,m.status==='fitted'?{status:m.status,selectedC:m.selectedC,calibration:m.calibration}:{status:m.status,reason:m.reason}])),
  dataChecks:checked.input.dataChecks,developmentTestConsumed:false,qualityGate:'not_evaluated',deployable:false};
 if(persist)await immutable(join(directory,'result.json'),result);
 else if(digest((await boundedJson(join(directory,'result.json'))).value)!==digest(result))throw Error('result_replay');
 return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const [mode,first,second,...extra]=process.argv.slice(2);if(extra.length||!first||!['register','run','verify'].includes(mode)||(mode==='register'?!second:second!==undefined))throw Error('arguments');
  const directory=safePath(mode==='register'?second:first);if(!directory.startsWith(join(root,'.tools')+sep))throw Error('research_directory');
  const result=mode==='register'?await register(safePath(first),directory):mode==='run'?await run(directory):await verify(directory);
  console.log(JSON.stringify(result));
 }catch(e){console.error(e?.code==='EEXIST'?'Запись уже существует. Для повторного опыта нужна новая связанная версия.':'Исследовательский запуск не выполнен. Проверьте SHA, окружение, протокол и файлы выбранного запуска.');process.exitCode=1;}
}
