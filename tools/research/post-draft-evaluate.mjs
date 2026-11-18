import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,relative,join,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {boundedJson,digest,sha} from './post-draft-dataset.mjs';
const {z}=createRequire(new URL('../../packages/contracts/package.json',import.meta.url))('zod');
const root=fileURLToPath(new URL('../../',import.meta.url));
const python=join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
const threads={OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1',NUMEXPR_NUM_THREADS:'1',PYTHONHASHSEED:'42'};
const hash=z.string().regex(/^[a-f0-9]{64}$/),Config=z.object({fitDirectory:z.string(),expectedArtifactSha256:hash}).strict();
const prediction=z.object({probability:z.number().finite().min(0).max(1),logit:z.number().finite()}).strict().nullable();
const predictions=z.object({M0:prediction,M1_raw:prediction,M1_cal:prediction,M2_raw:prediction,M2_cal:prediction}).strict();
const safe=p=>{const path=resolve(root,p),r=relative(root,path);if(!r||r.startsWith('..')||r.includes(':'))throw Error('outside_workspace');return path;};
const local=p=>relative(root,p).split(sep).join('/');
const immutable=(p,value)=>writeFile(p,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const execute=(cmd,args)=>{const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8',env:{...process.env,...threads},maxBuffer:2*1024*1024});if(r.status!==0)throw Error('subprocess_failed');return r.stdout;};
const environment=()=>JSON.parse(execute(python,['tools/research/post_draft_fit.py','environment']));

export function prepareEvaluationInput(dataset,inventory,protocol,artifact,sourceHashes,runtime){
 if(dataset.deployable!==false||artifact.deployable!==false||dataset.syntheticOnly!==false||artifact.syntheticOnly!==false||
  dataset.protocolFingerprint!==protocol.fingerprint||artifact.protocolFingerprint!==protocol.fingerprint)throw Error('research_binding');
 const byInventory=new Map(inventory.maps.map(m=>[m.matchId,m])),byProtocol=new Map(protocol.dispositions.map(m=>[m.matchId,m]));
 const labels=new Map(dataset.labels.map(l=>[l.matchId,l]));
 if(byInventory.size!==inventory.maps.length||byProtocol.size!==protocol.dispositions.length||labels.size!==dataset.labels.length)throw Error('duplicate_source');
 const ledger=dataset.rows.filter(r=>r.nominalWindow==='development_test'),rows=ledger.map(r=>{
  const p=byProtocol.get(r.matchId),info=byInventory.get(r.matchId),label=labels.get(r.matchId);
  if(!p||!info||p.nominalWindow!==r.nominalWindow||p.startedAt!==info.startedAt)throw Error('source_row');
  const values={M0:null,M1_raw:null,M1_cal:null,M2_raw:null,M2_cal:null},reasons=[...r.reasons];
  if(r.baselineEligible){
   if(!label||typeof label.teamAWon!=='boolean'||!label.sourceEvidence?.receiptId||!r.inputs)throw Error('verified_label_required');
   values.M0={logit:r.inputs.eloLogit,probability:runtime.sigmoid(r.inputs.eloLogit)};
  }
  if(r.pairedEligible){
   if(!r.baselineEligible)throw Error('paired_without_baseline');
   const vector=runtime.encode(r.inputs,artifact.heroVocabulary);
   for(const name of ['M1','M2']){
    const model=artifact.models[name];
    if(model.status!=='fitted'){reasons.push(name+'_MODEL_UNAVAILABLE');continue;}
    const inferred=runtime.infer(model,name,r.inputs,artifact.heroVocabulary),xs=name==='M1'?vector.slice(0,1):vector;
    const logit=xs.reduce((sum,x,i)=>sum+x*model.coefficients[i],0);
    values[name+'_raw']={logit,probability:inferred.rawProbability};
    if(inferred.calibratedProbability!==null)values[name+'_cal']={logit:logit/model.calibration.temperature,probability:inferred.calibratedProbability};
    else reasons.push(name+'_CALIBRATION_UNAVAILABLE');
   }
  }
  return {matchId:r.matchId,seriesKey:r.seriesKey,startedAt:p.startedAt,baselineEligible:r.baselineEligible,pairedEligible:r.pairedEligible,
   reasons:[...new Set(reasons)].sort(),label:label?.teamAWon??null,
   annotations:{provider:label?.sourceEvidence?.receiptId?'opendota':null,leagueId:info.leagueId??null,providerPatchId:info.providerPatchId??null,
    canonicalPatchId:info.canonicalPatchId??null,monthUTC:p.startedAt.slice(0,7)},predictions:predictions.parse(values)};
 });
 if(rows.length!==protocol.partitions.development_test.plannedDenominator||new Set(rows.map(r=>r.matchId)).size!==rows.length)throw Error('denominator_changed');
 rows.sort((a,b)=>BigInt(a.matchId)<BigInt(b.matchId)?-1:1);
 return {format:'conditional-evaluation-input-v1',policy:protocol.policy,rows,plannedDenominator:protocol.partitions.development_test.plannedDenominator,
  upstreamDataChecks:dataset.dataChecks,parityPassed:true,sourceHashes,syntheticOnly:false};
}
async function sources(config){
 execute(process.execPath,['tools/research/post-draft-fit.mjs','verify',config.fitDirectory]);
 const directory=safe(config.fitDirectory);
 const [fitManifest,fitArtifact,fitResult]=await Promise.all(['manifest.json','artifact.json','result.json'].map(p=>boundedJson(join(directory,p),16*1024*1024)));
 if(fitArtifact.sha256!==config.expectedArtifactSha256||fitArtifact.sha256!==fitResult.value.artifactSha256||fitResult.value.parity.status!=='PASS')throw Error('artifact_changed');
 const cfg=fitManifest.value.config;
 const [dataset,inventory,metadata,protocol]=await Promise.all(['dataset','inventory','metadata','protocol'].map(p=>boundedJson(safe(cfg[p]))));
 if(dataset.sha256!==cfg.expectedDatasetSha256||protocol.sha256!==cfg.expectedProtocolSha256||inventory.sha256!==protocol.value.inputs.inventorySha256||metadata.sha256!==protocol.value.inputs.metadataSha256)throw Error('frozen_inputs_changed');
 return {fitManifest,fitArtifact,fitResult,dataset,inventory,metadata,protocol,sourceHashes:Object.fromEntries(Object.entries({fitManifest,fitArtifact,fitResult,dataset,inventory,metadata,protocol}).map(([k,v])=>[k,v.sha256]))};
}
async function code(source){
 const inherited=[...source.fitManifest.value.code,...source.dataset.value.code,...source.protocol.value.code];
 const manifest=new Map();
 for(const entry of inherited){if(manifest.has(entry.path)&&manifest.get(entry.path)!==entry.sha256)throw Error('code_conflict');manifest.set(entry.path,entry.sha256);}
 for(const path of ['tools/research/post-draft-evaluate.mjs','tools/research/post_draft_evaluate.py','tests/node/post-draft-evaluate.test.mjs','tests/research/test_post_draft_evaluate.py'])manifest.set(path,sha(await readFile(safe(path))));
 for(const [path,expected] of manifest)if(sha(await readFile(safe(path)))!==expected)throw Error('upstream_code_changed');
 return [...manifest].sort(([a],[b])=>a<b?-1:1).map(([path,sha256])=>({path,sha256}));
}
async function register(configPath,directory){
 const config=Config.parse((await boundedJson(configPath,65536)).value),source=await sources(config),cfg=source.fitManifest.value.config;
 execute(process.execPath,['tools/research/freeze-post-draft.mjs','verify',...['inventory','metadata','protocol','capture','dataset'].map(k=>safe(cfg[k]))]);
 const pythonEnvironment=environment();if(digest(pythonEnvironment)!==digest(source.fitManifest.value.pythonEnvironment))throw Error('environment_changed');
 const manifest={format:'conditional-evaluation-manifest-v1',registeredAt:new Date().toISOString(),runDirectory:local(directory),config,
  sourceHashes:source.sourceHashes,code:await code(source),pythonEnvironment,node:process.version,threads,
  conventions:{logLoss:'stable logaddexp from fixed logits; no clipping',accuracy:'p>=0.5 selects Team A',reliability:'10 equal-width bins; last includes 1; empty nullable',
   bootstrap:'PCG64 seed42; 2000 shared whole-series resamples; map-weighted mean; percentile95 linear',strata:'provider/local league/provider patch/canonical patch/UTC month; no selective removal'},
  trainingPerformed:false,deployable:false};
 await mkdir(directory);await immutable(join(directory,'manifest.json'),manifest);
 return {status:'registered_before_evaluation',manifestSha256:sha(await readFile(join(directory,'manifest.json'))),sourceHashes:source.sourceHashes};
}
async function checked(directory){
 const manifest=await boundedJson(join(directory,'manifest.json'),2*1024*1024),m=manifest.value;
 if(m.format!=='conditional-evaluation-manifest-v1'||m.runDirectory!==local(directory)||m.deployable!==false||m.node!==process.version)throw Error('manifest_contract');
 const source=await sources(Config.parse(m.config));
 if(digest(source.sourceHashes)!==digest(m.sourceHashes)||digest(await code(source))!==digest(m.code)||digest(environment())!==digest(m.pythonEnvironment))throw Error('manifest_mismatch');
 return {source,manifest};
}
async function inputFor(source){
 return prepareEvaluationInput(source.dataset.value,source.inventory.value,source.protocol.value,source.fitArtifact.value,source.sourceHashes,
  await import(pathToFileURL(safe(source.fitManifest.value.compiled)).href));
}
function summary(report,manifestSha256,reportSha256){
 return {status:'completed_research_evaluation',manifestSha256,reportSha256,counts:report.counts,decision:report.decision,
  metrics:Object.fromEntries(Object.entries(report.pairedMetrics).map(([k,v])=>[k,{n:v.n,logLoss:v.logLoss,brier:v.brier,accuracy:v.accuracy,ece:v.ece}])),
  bootstrap:report.bootstrap,trainingPerformed:false,activationAllowed:false,deployable:false};
}
async function run(directory){
 const {source,manifest}=await checked(directory);
 await immutable(join(directory,'started.json'),{startedAt:new Date().toISOString(),manifestSha256:manifest.sha256});
 try{
  await immutable(join(directory,'input.json'),await inputFor(source));
  execute(python,['tools/research/post_draft_evaluate.py','evaluate',join(directory,'input.json'),join(directory,'manifest.json'),join(directory,'report.json')]);
  const report=await boundedJson(join(directory,'report.json'),16*1024*1024);
  if(report.value.manifestSha256!==manifest.sha256||report.value.inputSha256!==sha(await readFile(join(directory,'input.json')))||digest(report.value.sourceHashes)!==digest(source.sourceHashes))throw Error('report_binding');
  const result=summary(report.value,manifest.sha256,report.sha256);await immutable(join(directory,'result.json'),result);return result;
 }catch(e){await immutable(join(directory,'failed.json'),{status:'failed',reason:'EVALUATION_FAILED',manifestSha256:manifest.sha256,deployable:false});throw e;}
}
async function verify(directory){
 const {source,manifest}=await checked(directory),input=await boundedJson(join(directory,'input.json'),16*1024*1024);
 if(digest(await inputFor(source))!==digest(input.value))throw Error('input_replay');
 execute(python,['tools/research/post_draft_evaluate.py','verify',join(directory,'input.json'),join(directory,'manifest.json'),join(directory,'report.json')]);
 const report=await boundedJson(join(directory,'report.json'),16*1024*1024),expected=summary(report.value,manifest.sha256,report.sha256);
 if(digest((await boundedJson(join(directory,'result.json'))).value)!==digest(expected))throw Error('result_replay');return expected;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const [mode,first,second,...extra]=process.argv.slice(2);if(extra.length||!first||!['register','run','verify'].includes(mode)||(mode==='register'?!second:second!==undefined))throw Error('arguments');
  const directory=safe(mode==='register'?second:first);if(!directory.startsWith(join(root,'.tools')+sep))throw Error('research_directory');
  console.log(JSON.stringify(mode==='register'?await register(safe(first),directory):mode==='run'?await run(directory):await verify(directory)));
 }catch(e){console.error(e?.code==='EEXIST'?'Оценка или запись запуска уже существует. Для исправления нужна новая связанная версия.':'Исследовательская оценка не выполнена. Проверьте manifest, входные SHA, окружение и отдельный путь результата.');process.exitCode=1;}
}
