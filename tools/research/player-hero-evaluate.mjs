import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,relative,join,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {boundedJson,digest,sha} from './post-draft-dataset.mjs';
import {experimentPolicy} from './player-hero-experiment-plan.mjs';
import {checkPlayerHeroParity} from './player-hero-fit.mjs';
const {z}=createRequire(new URL('../../packages/contracts/package.json',import.meta.url))('zod');
const root=fileURLToPath(new URL('../../',import.meta.url));
const python=join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
const policy=experimentPolicy(),variants=['H0','H1_raw','H1_cal','H2_raw','H2_cal'];
const threads={OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1',NUMEXPR_NUM_THREADS:'1',PYTHONHASHSEED:'42'};
const Hash=z.string().regex(/^[a-f0-9]{64}$/);
const Prediction=z.object({logit:z.number().finite(),probability:z.number().finite().min(0).max(1)}).strict().nullable();
const Predictions=z.object(Object.fromEntries(variants.map(n=>[n,Prediction]))).strict();
const index=rows=>{const m=new Map(rows.map(r=>[r.matchId,r]));assert.equal(m.size,rows.length,'duplicate_source_map');return m;};
const numeric=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const local=p=>relative(root,p).split(sep).join('/');
const immutable=(p,v)=>writeFile(p,JSON.stringify(v)+'\n',{flag:'wx'});
function execute(cmd,args){const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8',env:{...process.env,...threads},maxBuffer:2*1024*1024});assert.equal(r.status,0,'subprocess_failed');return r.stdout;}
const environment=()=>JSON.parse(execute(python,['tools/research/post_draft_fit.py','environment']));

/** Called only AFTER evaluator registration. Uses fixed coefficients; never fitting or filtering by prediction. */
export function preparePlayerHeroEvaluation({dataset,labels,features,inventory,metadata,plan,artifact,sourceHashes,runtime}){
 assert.equal(dataset.format,'player-hero-experiment-dataset-v1');assert.equal(dataset.deployable,false);assert.equal(dataset.syntheticOnly,false);
 assert.equal(artifact.format,'player-hero-research-fit-v1');assert.equal(artifact.deployable,false);assert.equal(artifact.syntheticOnly,false);
 assert.equal(dataset.protocolFingerprint,plan.fingerprint);assert.equal(artifact.protocolFingerprint,plan.fingerprint);assert.deepEqual(plan.policy,policy);
 const all=index(dataset.rows),byLabel=index(labels.rows),byFeature=index(features.rows),byInventory=index(inventory.maps),byMeta=index(metadata);
 assert.deepEqual([...all.keys()].sort(numeric),[...plan.targetLedger.mapIds].sort(numeric),'target_ledger_changed');
 assert.deepEqual([...byFeature.keys()].sort(numeric),[...all.keys()].sort(numeric),'feature_ledger_changed');
 const reasons=[];
 for(const name of ['train','validation','calibration']){
  const block=dataset.partitions[name];assert.equal(artifact.counts[name],block.pairedMaps,'fit_cohort_changed');
  if(block.pairedMaps<policy.sampleFloors[name+'Maps'])reasons.push(name.toUpperCase()+'_MAPS_BELOW_FLOOR');
  if(Math.min(block.labels.teamAWins,block.labels.teamBWins)<policy.sampleFloors.minEachLabelPerFittedOrScoredBlock)reasons.push(name.toUpperCase()+'_LABELS_BELOW_FLOOR');
 }
 const rows=dataset.rows.filter(r=>r.nominalWindow==='development_test').map(r=>{
  const meta=byMeta.get(r.matchId),info=byInventory.get(r.matchId),f=byFeature.get(r.matchId),label=byLabel.get(r.matchId);
  assert(meta&&info&&f,'missing_source_row');assert.equal(r.startedAt,meta.startedAt);assert.equal(info.startedAt,r.startedAt);
  const predictions=Object.fromEntries(variants.map(k=>[k,null])),why=[...r.reasons];
  if(r.baselineEligible){
   assert(label&&typeof label.teamAWon==='boolean'&&label.completedAt===meta.completedAt&&label.completedAt>r.startedAt&&label.verifiedAt>=label.completedAt,'verified_label_required');
   Hash.parse(label.sourceEvidence.payloadSha256);
   predictions.H0={logit:r.eloLogit,probability:runtime.sigmoid(r.eloLogit)};
  }
  let players=null;
  if(r.pairedEligible){
   assert(r.baselineEligible&&f.feature?.status==='computed_research_only','invalid_paired_row');
   assert.equal(digest(f.feature),r.practiceSnapshotSha256,'practice_snapshot_changed');
   assert.equal(f.feature.scenario.targetMatchId,r.matchId);assert.equal(f.feature.scenario.cutoffAtUs,(BigInt(Date.parse(r.startedAt))*1000n).toString());
   assert.equal(r.inputs.eloLogit,r.eloLogit);assert.equal(r.inputs.observedHeroPracticeLog90Delta,f.feature.feature);
   const expectedSeries=meta.seriesId&&meta.seriesProvider==='opendota'&&/^[1-9]\d*$/.test(meta.sourceSeriesId??'')?JSON.stringify(['opendota',meta.sourceSeriesId]):null;
   assert(expectedSeries&&r.seriesKey===expectedSeries,'series_identity_changed');
   players=[...f.feature.teamA,...f.feature.teamB];assert.equal(players.length,10);assert(players.every(p=>Number.isInteger(p.nRaw)&&p.nRaw>=0&&Number.isInteger(p.heroUnknownMaps)&&p.heroUnknownMaps>=0));
   const vector=runtime.encode(r.inputs);
   for(const name of ['H1','H2']){
    const model=artifact.models[name];if(model.status!=='fitted'){why.push(name+'_MODEL_UNAVAILABLE');continue;}
    const inferred=runtime.infer(model,name,r.inputs),xs=name==='H1'?vector.slice(0,1):vector;
    const logit=xs.reduce((sum,x,i)=>sum+x*model.coefficients[i],0);
    predictions[name+'_raw']={logit,probability:inferred.rawProbability};
    if(inferred.calibratedProbability!==null)predictions[name+'_cal']={logit:logit/model.calibration.temperature,probability:inferred.calibratedProbability};
    else why.push(name+'_CALIBRATION_UNAVAILABLE');
   }
  }
  return {matchId:r.matchId,seriesKey:r.seriesKey,startedAt:r.startedAt,baselineEligible:r.baselineEligible,pairedEligible:r.pairedEligible,
   label:label?.teamAWon??null,reasons:[...new Set(why)].sort(),predictions:Predictions.parse(predictions),
   annotations:{provider:label?'opendota':null,leagueId:meta.leagueId,providerPatchId:info.providerPatchId??null,canonicalPatchId:info.canonicalPatchId??null,
    monthUTC:r.startedAt.slice(0,7),hasUnknownHeroHistory:players?players.some(p=>p.heroUnknownMaps>0):null,hasZeroObservedHeroCount:players?players.some(p=>p.nRaw===0):null}};
 });
 const denominator=plan.targetLedger.windows.find(w=>w.name==='development_test').plannedDenominator;
 assert.equal(rows.length,denominator);assert.equal(dataset.partitions.development_test.plannedDenominator,denominator);
 rows.sort((a,b)=>numeric(a.matchId,b.matchId));
 return {format:'player-hero-evaluation-input-v1',policy:experimentPolicy(),rows,plannedDenominator:denominator,
  upstreamDataChecks:{status:reasons.length?'insufficient':'passed_data_floors_only',reasons},parityPassed:true,sourceHashes,syntheticOnly:false};
}

const paths={plan:'docs/evidence/s3-04-player-hero-experiment-plan.json',dataset:'.tools/s304-hero-dataset-r1/dataset.json',
 labels:'.tools/s304-hero-dataset-r1/labels.json',features:'.tools/s304-hero-dataset-r1/features.json',datasetManifest:'.tools/s304-hero-dataset-r1/manifest.json',
 inventory:'.tools/s304-final.json',metadata:'.tools/s304-r2-metadata-r1.json',fitManifest:'.tools/s304-hero-fit-r1/manifest.json',
 fitArtifact:'.tools/s304-hero-fit-r1/artifact.json',fitResult:'.tools/s304-hero-fit-r1/result.json',
 fitEvidence:'docs/evidence/s3-04-player-hero-experiment-fit.json',datasetEvidence:'docs/evidence/s3-04-player-hero-experiment-dataset.json'};
async function sources(){
 const loaded={};for(const [k,p] of Object.entries(paths))loaded[k]=await boundedJson(join(root,p));
 const r=loaded,d=r.datasetManifest.value,f=r.fitManifest.value;
 for(const [k,n] of [['dataset','dataset.json'],['features','features.json'],['labels','labels.json'],['datasetManifest','manifest.json']])assert.equal(r[k].sha256,r.datasetEvidence.value.artifacts[n]);
 for(const [k,n] of [['fitManifest','manifest.json'],['fitArtifact','artifact.json'],['fitResult','result.json']])assert.equal(r[k].sha256,r.fitEvidence.value.artifacts[n]);
 for(const [k,ref] of Object.entries(d.inputs))assert.equal(sha(await readFile(join(root,ref.path))),ref.sha256,'dataset_input_changed');
 for(const ref of Object.values(f.sources))assert.equal(sha(await readFile(join(root,ref.path))),ref.sha256,'fit_source_changed');
 for(const [k,key] of [['plan','plan'],['inventory','inventory'],['metadata','metadata']])assert.equal(r[k].sha256,d.inputs[key].sha256);
 assert.equal(r.fitArtifact.value.datasetSha256,r.dataset.sha256);assert.equal(r.fitArtifact.value.labelsSha256,r.labels.sha256);
 assert.equal(r.fitResult.value.artifactSha256,r.fitArtifact.sha256);assert.equal(r.fitArtifact.value.manifestSha256,r.fitManifest.sha256);
 for(const item of [r.dataset,r.features,r.labels,r.plan]){const {fingerprint,...body}=item.value;assert.equal(digest(body),fingerprint);}
 const codeMap=new Map(f.code.map(e=>[e.path,e.sha256]));
 for(const entries of [d.code,r.plan.value.code])for(const [p,h] of Object.entries(entries)){assert(!codeMap.has(p)||codeMap.get(p)===h);codeMap.set(p,h);}
 for(const p of ['tools/research/player-hero-evaluate.mjs','tools/research/player_hero_evaluate.py','tools/research/post_draft_evaluate.py',
  'tests/node/player-hero-evaluate.test.mjs','tests/research/test_player_hero_evaluate.py'])codeMap.set(p,sha(await readFile(join(root,p))));
 for(const [p,h] of codeMap)assert.equal(sha(await readFile(join(root,p))),h,'code_changed');
 const runtime=await import(pathToFileURL(join(root,'.tools/s304-hero-fit-r1/compiled/player-hero-inference.mjs')).href);
 const parity=checkPlayerHeroParity(r.fitArtifact.value,runtime);assert.deepEqual(parity,r.fitResult.value.parity);
 return {loaded,runtime,parity,sourceHashes:Object.fromEntries(['plan','dataset','labels','features','inventory','metadata','fitManifest','fitArtifact','fitResult'].map(k=>[k,r[k].sha256])),
  allHashes:Object.fromEntries(Object.entries(loaded).map(([k,v])=>[k,v.sha256])),code:[...codeMap].sort(([a],[b])=>a<b?-1:1).map(([path,sha256])=>({path,sha256}))};
}
const inputFor=s=>preparePlayerHeroEvaluation({...Object.fromEntries(Object.entries(s.loaded).map(([k,v])=>[k,v.value])),artifact:s.loaded.fitArtifact.value,sourceHashes:s.sourceHashes,runtime:s.runtime});
async function register(directory){
 execute(process.execPath,['tools/research/player-hero-experiment-dataset.mjs','verify','.tools/s304-hero-dataset-r1']);
 const s=await sources(),pythonEnvironment=environment();assert.deepEqual(pythonEnvironment,s.loaded.fitManifest.value.environment.pythonEnvironment);
 const manifest={format:'player-hero-evaluation-manifest-v1',registeredAt:new Date().toISOString(),directory:local(directory),node:process.version,threads,
  pythonEnvironment,sourceHashes:s.sourceHashes,allHashes:s.allHashes,code:s.code,policy,parity:s.parity,
  conventions:{loss:'stable logaddexp; no clipping',accuracy:'p>=0.5 selects A',bins:'10 equal widths; last includes1; empty null',
   bootstrap:'2000 whole-series paired resamples;PCG64seed42;map-weighted;percentile95linear;exploratory',
   missingPredictions:'exclude whole known series from common cohort; retain raw available diagnostics and full denominator',
   strata:'all provider/league/provider-patch/canonical-patch/UTC-month; explicit true/false missingness groups including empty',
   firstResult:'immutable including negative/insufficient; no fitting or recalibration'},trainingPerformed:false,calibrationFittingPerformed:false,independentTest:false,deployable:false};
 await mkdir(directory);await immutable(join(directory,'manifest.json'),manifest);
 return {status:'registered_before_scoring',manifestSha256:sha(await readFile(join(directory,'manifest.json'))),deployable:false};
}
async function checked(directory){
 const manifest=await boundedJson(join(directory,'manifest.json')),m=manifest.value,s=await sources();
 assert.equal(m.format,'player-hero-evaluation-manifest-v1');assert.equal(m.directory,local(directory));assert.equal(m.node,process.version);
 assert.deepEqual(m.policy,policy);assert.deepEqual(m.sourceHashes,s.sourceHashes);assert.deepEqual(m.allHashes,s.allHashes);assert.deepEqual(m.code,s.code);
 assert.deepEqual(m.pythonEnvironment,environment());assert.deepEqual(m.threads,threads);assert.equal(m.deployable,false);assert.equal(m.trainingPerformed,false);
 assert.equal(m.calibrationFittingPerformed,false);assert.equal(m.independentTest,false);assert(m.registeredAt<=new Date().toISOString());return {s,manifest};
}
function summary(report,manifestSha256,reportSha256){
 return {status:'completed_research_evaluation',manifestSha256,reportSha256,counts:report.counts,decision:report.decision,
  metrics:Object.fromEntries(Object.entries(report.pairedMetrics).map(([k,m])=>[k,{n:m.n,series:m.series,logLoss:m.logLoss,brier:m.brier,accuracy:m.accuracy,correct:m.correct,ece:m.ece}])),
  bootstrap:report.bootstrap,trainingPerformed:false,calibrationFittingPerformed:false,independentTest:false,releaseGatePassed:false,activationAllowed:false,deployable:false};
}
async function verify(directory,persist=false){
 const {s,manifest}=await checked(directory),input=await boundedJson(join(directory,'input.json')),started=(await boundedJson(join(directory,'started.json'))).value;
 assert.equal(started.manifestSha256,manifest.sha256);assert(started.startedAt>=manifest.value.registeredAt&&started.startedAt<=new Date().toISOString());
 assert.deepEqual(input.value,inputFor(s),'input_replay');
 execute(python,['tools/research/player_hero_evaluate.py','verify',local(directory)]);
 const report=await boundedJson(join(directory,'report.json'));assert.equal(report.value.manifestSha256,manifest.sha256);assert.equal(report.value.inputSha256,input.sha256);
 const result=summary(report.value,manifest.sha256,report.sha256);
 if(persist)await immutable(join(directory,'result.json'),result);else assert.deepEqual((await boundedJson(join(directory,'result.json'))).value,result,'result_replay');return result;
}
async function main(){
 const [mode,path,...extra]=process.argv.slice(2);assert(['register','run','verify'].includes(mode)&&path&&!extra.length);
 const directory=resolve(root,path),rel=relative(join(root,'.tools'),directory);assert(rel&&!rel.startsWith('..')&&!rel.includes(':'));
 if(mode==='register'){console.log(JSON.stringify(await register(directory)));return;}
 if(mode==='run'){
  const {s,manifest}=await checked(directory);await immutable(join(directory,'started.json'),{manifestSha256:manifest.sha256,startedAt:new Date().toISOString()});
  try{await immutable(join(directory,'input.json'),inputFor(s));execute(python,['tools/research/player_hero_evaluate.py','evaluate',local(directory)]);
   console.log(JSON.stringify(await verify(directory,true)));}
  catch(e){await immutable(join(directory,'failed.json'),{status:'EVALUATION_FAILED',manifestSha256:manifest.sha256,deployable:false});throw e;}
 }else console.log(JSON.stringify(await verify(directory)));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{
 console.error(e.code==='EEXIST'?'Оценка уже зарегистрирована или выполнена; нужна отдельная версия.':'Оценка отклонена: проверьте протокол, источники, SHA и окружение.');process.exitCode=1;
});
