import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,relative,join,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {boundedJson,digest,sha} from './post-draft-dataset.mjs';
import {prepareEvaluationInput} from './post-draft-evaluate.mjs';
import {checkParity} from './post-draft-fit.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const python=join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
const threads={OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1',NUMEXPR_NUM_THREADS:'1',PYTHONHASHSEED:'42'};
const immutable=(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const local=p=>relative(root,p).split(sep).join('/');
function safe(p){const path=resolve(root,p),r=relative(root,path);assert(r&&!r.startsWith('..')&&!r.includes(':'));return path;}
function execute(cmd,args){const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8',env:{...process.env,...threads},maxBuffer:4*1024*1024});assert.equal(r.status,0,'subprocess_failed');return r.stdout;}
const environment=()=>JSON.parse(execute(python,['tools/research/post_draft_fit.py','environment']));
const paths={dataset:'.tools/s304-r2-dataset-r1.json',protocol:'docs/evidence/s3-04-r2-protocol.json',
 fitManifest:'.tools/s304-fit-r1/manifest.json',fitArtifact:'.tools/s304-fit-r1/artifact.json',fitResult:'.tools/s304-fit-r1/result.json',
 inventory:'.tools/s304-final.json',metadata:'.tools/s304-r2-metadata-r1.json',r1Protocol:'docs/evidence/s3-04-conditional-protocol.json',
 previousInput:'.tools/s304-eval-r1/input.json',previousReport:'.tools/s304-eval-r1/report.json',previousManifest:'.tools/s304-eval-r1/manifest.json',
 datasetEvidence:'docs/evidence/s3-04-r2-frozen-dataset.json',evaluationEvidence:'docs/evidence/s3-04-offline-evaluation.json'};

export function prepareR2Input(dataset,plan,referenceProtocol,inventory,artifact,sourceHashes,runtime){
 assert.equal(dataset.format,'conditional-post-draft-r2-dataset-v1');assert.equal(dataset.protocolFingerprint,plan.fingerprint);
 assert.equal(dataset.r1ProtocolFingerprint,referenceProtocol.fingerprint);assert.equal(artifact.protocolFingerprint,referenceProtocol.fingerprint);
 assert.equal(plan.parameters.coefficientFittingAllowed,false);assert.equal(plan.parameters.calibrationFittingAllowed,false);
 assert.deepEqual(dataset.heroVocabulary,artifact.heroVocabulary);assert.deepEqual(dataset.policy,referenceProtocol.policy);
 assert.deepEqual(plan.inheritedPolicy,referenceProtocol.policy);
 assert.deepEqual(dataset.rows.map(r=>r.matchId).sort(),[...plan.targetLedger.mapIds].sort());
 for(const name of ['train','validation'])assert.equal(dataset.earlyParity[name].status,'exact_except_declared_snapshot_provenance');
 // Explicit compatibility view for the unchanged R1 scorer. Stored R2 provenance remains separate and immutable.
 return prepareEvaluationInput({...dataset,protocolFingerprint:referenceProtocol.fingerprint},inventory,referenceProtocol,artifact,sourceHashes,runtime);
}
async function sources(){
 const loaded=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([k,p])=>[k,await boundedJson(safe(p))])));
 const {dataset,protocol,fitManifest,fitArtifact,fitResult,inventory,metadata,r1Protocol,previousInput,previousReport,previousManifest,datasetEvidence,evaluationEvidence}=loaded;
 assert.equal(dataset.sha256,datasetEvidence.value.datasetSha256);assert.equal(dataset.value.inputs.r2PlanSha256,protocol.sha256);
 assert.equal(protocol.value.frozenFiles.r1Artifact.sha256,fitArtifact.sha256);assert.equal(protocol.value.inputs.protocol.sha256,r1Protocol.sha256);
 assert.equal(protocol.value.inputs.metadata.sha256,metadata.sha256);assert.equal(r1Protocol.value.inputs.inventorySha256,inventory.sha256);
 assert.equal(fitArtifact.sha256,fitResult.value.artifactSha256);assert.equal(fitArtifact.value.manifestSha256,fitManifest.sha256);
 assert.equal(previousManifest.sha256,evaluationEvidence.value.artifacts['manifest.json']);
 assert.equal(previousInput.sha256,evaluationEvidence.value.artifacts['input.json']);assert.equal(previousReport.sha256,evaluationEvidence.value.artifacts['report.json']);
 assert.equal(previousReport.value.inputSha256,previousInput.sha256);assert.equal(previousReport.value.manifestSha256,previousManifest.sha256);
 for(const [k,v] of Object.entries({fitManifest,fitArtifact,fitResult}))assert.equal(v.sha256,previousInput.value.sourceHashes[k]);
 const {fingerprint,...body}=dataset.value;assert.equal(digest(body),fingerprint,'dataset_fingerprint');
 const runtime=await import(pathToFileURL(safe(fitManifest.value.compiled)).href),parity=checkParity(fitArtifact.value,runtime);
 assert.deepEqual(parity,fitResult.value.parity);
 const inherited=[...fitManifest.value.code,...dataset.value.code,...r1Protocol.value.code,...previousManifest.value.code,
  ...Object.entries(dataset.value.implementation).map(([path,sha256])=>({path,sha256})),...Object.entries(protocol.value.code).map(([path,sha256])=>({path,sha256}))];
 const codeMap=new Map();for(const e of inherited){if(codeMap.has(e.path))assert.equal(codeMap.get(e.path),e.sha256);codeMap.set(e.path,e.sha256);}
 for(const p of ['tools/research/post-draft-r2-evaluate.mjs','tools/research/post_draft_r2_evaluate.py','tests/node/post-draft-r2-evaluate.test.mjs','tests/research/test_post_draft_r2_evaluate.py'])codeMap.set(p,sha(await readFile(safe(p))));
 for(const [p,hash] of codeMap)assert.equal(sha(await readFile(safe(p))),hash,'code_changed');
 const sourceHashes=Object.fromEntries(Object.entries({fitManifest,fitArtifact,fitResult,dataset,inventory,metadata,protocol}).map(([k,v])=>[k,v.sha256]));
 return {loaded,sourceHashes,allHashes:Object.fromEntries(Object.entries(loaded).map(([k,v])=>[k,v.sha256])),runtime,parity,
  code:[...codeMap].sort(([a],[b])=>a<b?-1:1).map(([path,sha256])=>({path,sha256}))};
}
function inputFor(s){const r=s.loaded;return {format:'post-draft-r2-evaluation-input-v1',
 current:prepareR2Input(r.dataset.value,r.protocol.value,r.r1Protocol.value,r.inventory.value,r.fitArtifact.value,s.sourceHashes,s.runtime),
 previous:r.previousInput.value};}
async function checked(directory){
 const manifest=await boundedJson(join(directory,'manifest.json')),m=manifest.value,s=await sources();
 assert.equal(m.format,'post-draft-r2-evaluation-manifest-v1');assert.equal(m.runDirectory,local(directory));assert.equal(m.node,process.version);
 assert.deepEqual(m.allSourceHashes,s.allHashes);assert.deepEqual(m.code,s.code);assert.deepEqual(m.pythonEnvironment,environment());
 assert.equal(m.deployable,false);assert.equal(m.trainingPerformed,false);assert(m.registeredAt<=new Date().toISOString());
 return {s,manifest};
}
function summary(report,manifestSha256,reportSha256){
 const compact=metrics=>Object.fromEntries(Object.entries(metrics).map(([k,m])=>[k,{n:m.n,series:m.series,logLoss:m.logLoss,brier:m.brier,accuracy:m.accuracy,correct:m.correct,ece:m.ece}]));
 return {status:'completed_research_evaluation',manifestSha256,reportSha256,counts:report.overall.counts,decision:report.overall.decision,
  metrics:compact(report.overall.pairedMetrics),bootstrap:report.overall.bootstrap,
  common:{maps:report.common.mapIds.length,R1:compact(report.common.R1),R2:compact(report.common.R2),deltas:report.common.deltas},
  recovered:{maps:report.recovered.mapIds.length,metrics:compact(report.recovered.metrics)},lostMaps:report.lost.mapIds.length,
  trainingPerformed:false,calibrationFittingPerformed:false,independentTest:false,activationAllowed:false,deployable:false};
}
async function register(directory){
 // Replay inputs without inference before registering the first scoring run.
 execute(process.execPath,['tools/research/post-draft-r2-dataset.mjs','verify',paths.dataset]);
 const s=await sources(),pythonEnvironment=environment();assert.deepEqual(pythonEnvironment,s.loaded.fitManifest.value.pythonEnvironment);
 const manifest={format:'post-draft-r2-evaluation-manifest-v1',registeredAt:new Date().toISOString(),runDirectory:local(directory),
  sourceHashes:s.sourceHashes,allSourceHashes:s.allHashes,previousSourceHashes:s.loaded.previousInput.value.sourceHashes,
  code:s.code,pythonEnvironment,node:process.version,threads,parity:s.parity,
  conventions:{referenceScorer:'unchanged R1 policy/scorer via explicit R2 parent binding; original files never rewritten',
   cohorts:'full fixed denominator, exact common IDs, recovered and lost separately; no metric-based selection',
   bootstrap:'2000 whole-series paired resamples, PCG64 seed42, map weighted, percentile95 linear; exploratory',
   primary:'R2 M2_cal minus R2 M1_cal; same-map R2 minus R1 for each fixed variant is secondary',
   firstResult:'single immutable start and result, including negative/insufficient; no refit or recalibration'},
  trainingPerformed:false,calibrationFittingPerformed:false,independentTest:false,deployable:false};
 await mkdir(directory);await immutable(join(directory,'manifest.json'),manifest);
 return {status:'registered_before_scoring',manifestSha256:sha(await readFile(join(directory,'manifest.json'))),parity:s.parity,deployable:false};
}
async function run(directory){
 const {s,manifest}=await checked(directory),startedAt=new Date().toISOString();assert(startedAt>=manifest.value.registeredAt);
 await immutable(join(directory,'started.json'),{startedAt,manifestSha256:manifest.sha256});
 try{
  await immutable(join(directory,'input.json'),inputFor(s));
  execute(python,['tools/research/post_draft_r2_evaluate.py','evaluate',join(directory,'input.json'),join(directory,'manifest.json'),join(directory,'report.json')]);
  const report=await boundedJson(join(directory,'report.json'));assert.equal(report.value.manifestSha256,manifest.sha256);
  assert.equal(report.value.inputSha256,sha(await readFile(join(directory,'input.json'))));
  const result=summary(report.value,manifest.sha256,report.sha256);await immutable(join(directory,'result.json'),result);return result;
 }catch(e){await immutable(join(directory,'failed.json'),{status:'failed',manifestSha256:manifest.sha256,reason:'R2_EVALUATION_FAILED',deployable:false});throw e;}
}
async function verify(directory){
 const {s,manifest}=await checked(directory),input=await boundedJson(join(directory,'input.json'));
 assert.equal(digest(inputFor(s)),digest(input.value),'input_replay');
 const started=(await boundedJson(join(directory,'started.json'))).value;assert.equal(started.manifestSha256,manifest.sha256);assert(started.startedAt>=manifest.value.registeredAt);
 execute(python,['tools/research/post_draft_r2_evaluate.py','verify',join(directory,'input.json'),join(directory,'manifest.json'),join(directory,'report.json')]);
 const report=await boundedJson(join(directory,'report.json')),expected=summary(report.value,manifest.sha256,report.sha256);
 assert.equal(digest((await boundedJson(join(directory,'result.json'))).value),digest(expected));return expected;
}
async function main(){const [mode,path,...extra]=process.argv.slice(2);assert(['register','run','verify'].includes(mode)&&path&&!extra.length);const directory=safe(path);assert(directory.startsWith(join(root,'.tools')+sep));
 console.log(JSON.stringify(await ({register,run,verify}[mode])(directory)));}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{
 console.error(e.code==='EEXIST'?'Запуск R2 уже зарегистрирован или выполнен; нужна отдельная связанная версия.':'Оценка R2 отклонена: проверьте manifest, SHA, окружение и отдельный каталог.');process.exitCode=1;
});
