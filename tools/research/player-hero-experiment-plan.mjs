import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,relative,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {boundedJson,digest,sha} from './post-draft-dataset.mjs';
const {z}=createRequire(new URL('../../packages/contracts/package.json',import.meta.url))('zod');
const root=fileURLToPath(new URL('../../',import.meta.url));
const policyPath='tools/research/player-hero-experiment-policy.json';
const policy=JSON.parse(await readFile(join(root,policyPath),'utf8'));
export const experimentPolicy=()=>structuredClone(policy);
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(x=>BigInt(x)<=9223372036854775807n);
const Time=z.string().datetime({precision:3}).refine(x=>Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x);
const Window=z.enum(['warmup','train','validation','calibration','development_test']).nullable();
const Target=z.object({matchId:Id,seriesKey:z.string().nullable(),nominalWindow:Window,pairedEligible:z.boolean()}).strict();
const Feature=z.object({matchId:Id,nominalWindow:Window,originalPairedEligible:z.boolean(),
 status:z.enum(['computed_research_only','unavailable','not_requested','originally_ineligible']),feature:z.number().finite().nullable()}).strict();
const Metadata=z.object({matchId:Id,seriesId:z.string().nullable(),startedAt:Time,completedAt:Time.nullable(),
 mapNumber:z.union([z.number().int(),z.string()]).nullable(),leagueId:z.string().nullable(),dataRevision:z.string(),
 sourceSeriesId:z.string().nullable(),seriesProvider:z.string().nullable(),gameMode:z.string().nullable(),lobbyType:z.string().nullable()}).strict();
const Input=z.object({registeredAt:Time,featurePolicy:z.unknown(),targets:z.array(Target).max(5000),features:z.array(Feature).max(5000),
 metadata:z.array(Metadata).max(5000),addedHistoryIds:z.array(Id).max(5000)}).strict();
const numeric=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const sorted=ids=>[...ids].sort(numeric);
const index=rows=>{const result=new Map(rows.map(r=>[r.matchId,r]));assert.equal(result.size,rows.length,'duplicate_map');return result;};
const seriesKey=m=>m.seriesId&&m.seriesProvider==='opendota'&&/^[1-9]\d*$/.test(m.sourceSeriesId??'')?JSON.stringify(['opendota',m.sourceSeriesId]):null;

/** Only ledger metadata and feature availability, never target labels or prediction metrics. */
export function buildPlayerHeroExperimentPlan(raw){
 const input=Input.parse(raw),{targets,features,metadata,registeredAt}=input;
 assert.deepEqual(input.featurePolicy,policy.featureContract,'feature_contract_changed');
 const t=index(targets),f=index(features),m=index(metadata),added=new Set(input.addedHistoryIds),groups=new Map(),aliases=new Map();
 assert.equal(added.size,input.addedHistoryIds.length,'duplicate_history_id');
 assert.deepEqual(sorted(t.keys()),sorted(f.keys()),'feature_target_ledger_changed');
 assert([...added].every(id=>!t.has(id)),'history_became_target');
 assert.deepEqual(sorted(m.keys()),sorted([...t.keys(),...added]),'exposure_scope_changed');
 for(const meta of metadata){
  assert(meta.startedAt<registeredAt&&(!meta.completedAt||(meta.completedAt>meta.startedAt&&meta.completedAt<=registeredAt)),'invalid_metadata_clock');
  const key=seriesKey(meta);
  if(key){if(aliases.has(meta.seriesId))assert.equal(aliases.get(meta.seriesId),key,'series_alias_conflict');aliases.set(meta.seriesId,key);
   const list=groups.get(key)??[];list.push(meta);groups.set(key,list);}
 }
 for(const row of targets){
  const feature=f.get(row.matchId),meta=m.get(row.matchId),window=policy.windows.find(w=>meta.startedAt>=w.from&&meta.startedAt<w.until);
  assert.equal(row.nominalWindow,window?.name??null,'window_changed');
  assert.equal(feature.nominalWindow,row.nominalWindow);assert.equal(feature.originalPairedEligible,row.pairedEligible,'eligibility_changed');
  const requested=['train','validation'].includes(row.nominalWindow);
  if(!requested){assert.equal(feature.status,'not_requested','protected_partition_consumed');assert.equal(feature.feature,null);}
  else if(!row.pairedEligible){assert.equal(feature.status,'originally_ineligible');assert.equal(feature.feature,null);}
  else {assert.equal(feature.status,'computed_research_only','registered_train_validation_feature_unavailable');assert.notEqual(feature.feature,null);}
  if(row.pairedEligible){
   assert(window&&row.seriesKey&&row.seriesKey===seriesKey(meta),'eligible_series_unverified');
   for(const sibling of groups.get(row.seriesKey)){
    assert(sibling.startedAt>=window.from&&sibling.startedAt<window.until&&sibling.completedAt&&sibling.completedAt<window.until,'series_crosses_window');
    const target=t.get(sibling.matchId);assert(!target||target.pairedEligible,'mixed_eligible_series');
   }
  }
 }
 const windows=policy.windows.map(w=>{
  const rows=targets.filter(r=>r.nominalWindow===w.name),eligible=rows.filter(r=>r.pairedEligible);
  return {...w,plannedDenominator:rows.length,r2EligibleUpperBound:eligible.length,knownEligibleSeries:new Set(eligible.map(r=>r.seriesKey)).size,
   practiceComputed:rows.filter(r=>f.get(r.matchId).status==='computed_research_only').length,
   pairedDatasetStatus:['train','validation'].includes(w.name)?'feature_available_dataset_not_yet_frozen':'feature_not_computed_new_dataset_required'};
 });
 return {format:'player-hero-experiment-plan-v1',registeredAt,status:'registered_development_experiment',policy:experimentPolicy(),
  targetLedger:{count:targets.length,mapIds:sorted(t.keys()),addedHistoryOnlyIds:sorted(added),windows,
   outsideWindows:targets.filter(r=>r.nominalWindow===null).length,denominatorMayShrink:false},
  exposure:{basis:'all_frozen_R1_R2_maps_previously_exposed',mapIds:sorted(m.keys()),canonicalSeriesKeys:[...groups.keys()].sort(),
   unknownSeriesMapIds:sorted(metadata.filter(x=>!seriesKey(x)).map(x=>x.matchId)),maps:metadata.length,
   latestFrozenEvent:metadata.map(x=>x.startedAt).sort().at(-1)??null,independentMapsEstablished:0,
   currentDatabaseNotQueried:true,priorAggregateEvaluationKnown:true,individualLabelsOrProbabilitiesUsedByPlanner:false},
  action:{thisStep:'registration_only',fittingPerformed:false,scoringPerformed:false,activationAllowed:false},
  deployable:false};
}
const refs={featureEvidence:'docs/evidence/s3-04-player-hero-feature-contract.json',manifest:'.tools/s304-hero-contract-r1/manifest.json',
 features:'.tools/s304-hero-contract-r1/features.json',runtime:'.tools/s304-hero-contract-r1/runtime.mjs',dataset:'.tools/s304-r2-dataset-r1.json',
 metadata:'.tools/s304-r2-metadata-r1.json',r2Evidence:'docs/evidence/s3-04-r2-offline-evaluation.json'};
async function prepare(registeredAt){
 const loaded={};for(const [key,path] of Object.entries(refs))loaded[key]=key==='runtime'?{sha256:sha(await readFile(join(root,path)))}:await boundedJson(join(root,path));
 const e=loaded.featureEvidence.value,m=loaded.manifest.value,features=loaded.features.value,d=loaded.dataset.value;
 for(const [key,file] of [['manifest','manifest.json'],['features','features.json'],['runtime','runtime.mjs']])assert.equal(loaded[key].sha256,e.artifacts[file]);
 assert.equal(loaded.dataset.sha256,m.inputs.dataset);assert.equal(loaded.metadata.sha256,d.inputs.metadataSha256);
 assert.equal(features.manifestSha256,loaded.manifest.sha256);assert.equal(loaded.runtime.sha256,m.compiledSha256);
 assert.equal(loaded.dataset.sha256,loaded.r2Evidence.value.sourceHashes.dataset);
 for(const [path,hash] of Object.entries(m.code))assert.equal(sha(await readFile(join(root,path))),hash,'frozen_feature_code_changed');
 const {fingerprint,...featureBody}=features;assert.equal(digest(featureBody),fingerprint);
 assert(!d.syntheticOnly&&!d.deployable&&!features.deployable);assert.deepEqual(m.partitions,['train','validation']);
 const plan=buildPlayerHeroExperimentPlan({registeredAt,featurePolicy:m.policy,
  targets:d.rows.map(r=>({matchId:r.matchId,seriesKey:r.seriesKey,nominalWindow:r.nominalWindow,pairedEligible:r.pairedEligible})),
  features:features.rows.map(r=>({matchId:r.matchId,nominalWindow:r.nominalWindow,originalPairedEligible:r.originalPairedEligible,status:r.status,feature:r.feature?.feature??null})),
  metadata:loaded.metadata.value,addedHistoryIds:d.targetLedger.addedHistoryOnlyIds});
 const code={};for(const p of [policyPath,'tools/research/player-hero-experiment-plan.mjs','tests/node/player-hero-experiment-plan.test.mjs'])code[p]=sha(await readFile(join(root,p)));
 return {...plan,inputs:Object.fromEntries(Object.entries(loaded).map(([k,v])=>[k,{path:refs[k],sha256:v.sha256}])),code};
}
async function main(){
 const [mode,path,...extra]=process.argv.slice(2);assert(['create','verify'].includes(mode)&&path&&!extra.length);
 const output=resolve(root,path),rel=relative(root,output);assert(rel&&!rel.startsWith('..')&&!rel.includes(':'));
 const saved=mode==='verify'?(await boundedJson(output)).value:null,registeredAt=saved?.registeredAt??new Date().toISOString();
 assert(registeredAt<=new Date().toISOString());const body=await prepare(registeredAt),result={...body,fingerprint:digest(body)};
 if(mode==='create')await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 else assert.equal(digest(result),digest(saved),'plan_replay');
 console.log(JSON.stringify({status:mode==='create'?'registered_development_experiment':'verified_development_experiment',fingerprint:result.fingerprint,
  windows:result.targetLedger.windows,exposedMaps:result.exposure.maps,independent:result.policy.independentEvaluation.status,deployable:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{
 console.error(e.code==='EEXIST'?'План уже существует; нужна отдельная связанная версия.':'План отклонён: проверьте контракт, SHA, реестр целей и границы серий.');process.exitCode=1;
});
