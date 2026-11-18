/** Register a history-only development replay. No fitting, inference, DB or HTTP. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile, stat, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {z}=createRequire(new URL('../../packages/contracts/package.json',import.meta.url))('zod');
const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n);
const Timestamp=z.string().datetime().refine(v=>new Date(v).toISOString()===v);
const Metadata=z.array(z.object({
 matchId:Id,seriesId:z.string().nullable(),startedAt:Timestamp,completedAt:Timestamp.nullable(),
 mapNumber:z.number().int().positive().nullable(),leagueId:Id.nullable(),dataRevision:z.string().regex(/^\d+$/),
 sourceSeriesId:z.string().nullable(),seriesProvider:z.string().nullable(),gameMode:z.string().nullable(),lobbyType:z.string().nullable()
}).strict()).max(5000);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const digest=value=>sha(canonical(value));
const numeric=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
function unique(rows){const m=new Map(rows.map(r=>[r.matchId,r]));assert.equal(m.size,rows.length,'duplicate_map');return m;}

export function buildR2Plan({protocol,baselineMetadata,metadata,addedIds,coverage,plannedAt}){
 Timestamp.parse(plannedAt);Metadata.parse(baselineMetadata);Metadata.parse(metadata);z.array(Id).parse(addedIds);
 const old=unique(baselineMetadata),current=unique(metadata),targets=unique(protocol.dispositions);
 assert.deepEqual([...old.keys()].sort(numeric),[...targets.keys()].sort(numeric),'original_target_ledger');
 assert.equal(new Set(addedIds).size,addedIds.length,'duplicate_added_id');
 assert.equal(metadata.length,old.size+addedIds.length,'unplanned_current_maps');
 for(const [id,row] of old){assert.deepEqual(current.get(id),row,'original_metadata_drift');const t=targets.get(id);assert.equal(t.startedAt,row.startedAt);assert.equal(t.completedAt,row.completedAt);assert.equal(t.dataRevision,row.dataRevision);}
 for(const id of addedIds)assert(!old.has(id)&&current.has(id),'addition_scope');
 const windows=protocol.policy.windows;
 assert.equal(windows.at(-1).name,'development_test');
 for(let i=0;i<windows.length;i++){
  const w=windows[i];Timestamp.parse(w.from);Timestamp.parse(w.until);assert(w.from<w.until&&w.until<=plannedAt,'invalid_window');
  if(i)assert.equal(w.from,windows[i-1].until,'window_gap_or_overlap');
 }
 const validation=windows.find(w=>w.name==='validation');assert(validation);
 const added=addedIds.map(id=>current.get(id));
 // R2 fixes all fitted parameters. Earlier additions would require a new plan.
 assert(added.every(m=>m.startedAt>=validation.until&&m.startedAt<plannedAt&&m.completedAt&&m.completedAt>m.startedAt&&m.completedAt<=plannedAt),'history_changes_fitting_period');
 assert.equal(coverage.minimumPriorMaps,protocol.policy.history.minCompletedProMapsPerPlayer);
 assert.equal(coverage.counts.importedMaps,addedIds.length);
 assert.deepEqual(coverage.contributions.map(m=>m.matchId).sort(numeric),[...addedIds].sort(numeric),'coverage_additions');
 const late=protocol.dispositions.filter(r=>r.nominalWindow==='development_test');
 assert.equal(coverage.originalCohort.denominator,late.length,'coverage_denominator');
 assert(coverage.fixedCohortCoverageOnly.independentTest===false&&coverage.deployable===false);
 const dates=metadata.map(m=>m.startedAt).sort();
 const partitions=windows.map(w=>({name:w.name,from:w.from,until:w.until,
  originalTargetDenominator:protocol.dispositions.filter(r=>r.nominalWindow===w.name).length,
  addedHistoryMaps:added.filter(m=>m.startedAt>=w.from&&m.startedAt<w.until).length}));
 return {
  format:'post-draft-r2-history-replay-plan-v1',status:'registered_development_plan',plannedAt,
  purpose:'measure_history_addition_only_with_frozen_R1_parameters',
  exposure:{basis:'previously_exposed_retrospective_development',allCurrentMapsExposed:true,
   currentMaps:metadata.length,earliestEvent:dates[0]??null,latestEvent:dates.at(-1)??null,
   mapsOnOrAfterOriginalDevelopmentEnd:metadata.filter(m=>m.startedAt>=windows.at(-1).until).length,
   independentMapsEstablished:0,individualOutcomesUsedByPlanner:false,priorAggregateEvaluationKnown:true},
  targetLedger:{source:'R1 protocol dispositions, exact IDs and original nominal windows',mapIds:[...targets.keys()].sort(numeric),
   count:targets.size,partitions,newHistoryIds:[...addedIds].sort(numeric),newHistoryMayBecomeTargets:false,
   denominatorPolicy:'retain every original target and every exclusion; never reduce denominator to available predictions'},
  inheritedPolicy:structuredClone(protocol.policy),
  parameters:{coefficientFittingAllowed:false,calibrationFittingAllowed:false,hyperparameterSelectionAllowed:false,
   artifact:'exact R1 artifact bytes including M1/M2 coefficients, C, vocabulary, feature order and temperatures',
   M0:'same initial1500/K32/scale400 Elo policy; recompute chronological state with exact added history',
   baseline:'M0 M1 M2 all receive the same R2 historical snapshot',
   trainAndValidation:'must reproduce R1 eligibility, ordered features and labels exactly or stop',
   calibration:'do not refit or choose temperatures on changed history; preserve R1 temperatures; report possible calibration drift'},
  data:{source:`frozen coverage capture; retain original target facts and add only approved ${addedIds.length} history IDs`,
   historyMinimum:coverage.minimumPriorMaps,availability:'conditional_event_time_assumed; reconstructed lineups/heroes; no known_at backdating',
   strictCutoff:'history.started_at < target.started_at AND history.completed_at < target.started_at; exclude target',
   series:'revalidate all known series members including history-only siblings; reject conflicts, unknown/incomplete series and boundary crossing',
   identities:'exact canonical player/account evidence; no nick merges; reject drift in original history',
   draft:'10 distinct final heroes on verified native sides; full draft timeline not required for hero-only diagnostic',
   scope:'one verified professional map, any known/unknown map number; not a first-map or series-win claim',
   tournamentTier:'record source/tier or null; no manual Tier1 gate or invented tier; no Tier1-specific conclusion from this mixed corpus'},
  evaluation:{...structuredClone(protocol.policy.evaluation),
   interpretation:'exploratory sensitivity only; coverage-driven selection was informed by R1; no independent confirmation',
   comparisons:['R2 M2_cal versus R2 M1_cal and R2 M0 on identical available maps',
    'R2 versus R1 for each fixed model on the exact common eligible target IDs',
    'newly recovered targets separately with N and reasons; do not attribute cohort-composition changes to accuracy gains'],
   preserveR1Result:true,freezeEvaluatorBeforeScoring:true,firstResultOnly:true,
   noOptionalStoppingOrBestRevisionSelection:true,probabilitiesInUIAllowed:false},
  coveragePreview:{...structuredClone(coverage.fixedCohortCoverageOnly),original:structuredClone(coverage.originalCohort),
   status:'upper_bound_only_not_dataset_eligibility',remainingDeficientTargets:coverage.counts.targetsStillDeficient},
  independentEvaluation:{status:'not_registered_not_ready',from:null,until:null,candidateFreezeSha256:null,eventEditionScope:null,
   earliestPermittedStart:'strictly after final candidate/evaluator/source-policy registration; actual UTC dates must be registered before collection',
   requirements:['freeze candidate, feature builder, environment, calibration and evaluator before new target series begin',
    'register source/event-edition universe, fixed date window, sample floors and one terminal assessment in advance',
    'audit outcome-blind enrollment ledger and series aliases against all prior exposed targets',
    'capture final10 heroes, lineups, identities and histories with stage timestamps before map start; preserve misses/cancellations/mismatches',
    'link only verified actual professional map outcomes separately after completion',
    'preserve whole-series splits, unavailable denominator and strata; source/completeness gaps remain explicit',
    'resolve hero/patch scope and validate Python/TS parity before any release decision'],
   stopping:'insufficient at the registered deadline stays insufficient; no extension or retuning chosen from observed performance',
   existingV1Window:'not changed, shared or silently repurposed',
   currentBlockers:['NO_ESTABLISHED_UNEXPOSED_LOCAL_COHORT','NO_FROZEN_R2_RELEASE_CANDIDATE','NO_REGISTERED_POST_DRAFT_CAPTURE_AND_EVALUATION_WINDOW']},
  nextTask:'S3-04/R2-frozen-dataset',datasetReady:false,trainingPerformed:false,targetScoringPerformed:false,
  providerHttp:0,businessWrites:0,deployable:false,modelActivationAllowed:false
 };
}

const paths={protocol:'docs/evidence/s3-04-conditional-protocol.json',baselineMetadata:'.tools/s304-plan-metadata-final.json',
 metadata:'.tools/s304-r2-metadata-r1.json',coverage:'.tools/s304-history-coverage-r2.json',
 fitSummary:'docs/evidence/s3-04-offline-fit.json',evaluationSummary:'docs/evidence/s3-04-offline-evaluation.json',
 importReport:'.tools/s304-history-import-apply-r1/report.json'};
async function json(path){const s=await stat(path);assert(s.size<=32*1024*1024);const bytes=await readFile(path);return {value:JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')),sha256:sha(bytes)};}
async function prepare(plannedAt){
 const input=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([k,p])=>[k,await json(p)])));
 const p=input.protocol.value,{fingerprint,...body}=p;assert.equal(sha(JSON.stringify(body)),fingerprint,'protocol_fingerprint');
 const c=input.coverage.value,fit=input.fitSummary.value,e=input.evaluationSummary.value;
 assert.equal(input.protocol.sha256,e.sourceHashes.protocol);assert.equal(input.baselineMetadata.sha256,e.sourceHashes.metadata);
 assert.equal(input.importReport.sha256,c.inputs.importReport);assert.equal(fit.datasetSha256,c.inputs.dataset);
 assert.equal(fit.protocolFingerprint,p.fingerprint);assert.equal(e.sourceHashes.dataset,c.inputs.dataset);
 const artifact=fit.artifacts.find(a=>a.path==='.tools/s304-fit-r1/artifact.json');assert(artifact);
 assert.equal(artifact.sha256,e.sourceHashes.fitArtifact);
 const boundFiles={r1Dataset:'.tools/s304-dataset-final.json',r1Artifact:artifact.path,r1Evaluation:'.tools/s304-eval-r1/report.json',historyCapture:'.tools/s304-history-coverage-source-r1.json'};
 const expected={r1Dataset:c.inputs.dataset,r1Artifact:artifact.sha256,r1Evaluation:e.artifacts['report.json'],historyCapture:c.inputs.currentSource};
 for(const [k,path] of Object.entries(boundFiles))assert.equal(sha(await readFile(path)),expected[k],'frozen_bytes_changed');
 const addedIds=input.importReport.value.base.map(m=>m.matchId);
 const plan=buildR2Plan({protocol:p,baselineMetadata:input.baselineMetadata.value,metadata:input.metadata.value,addedIds,coverage:c,plannedAt});
 const code={};for(const path of ['tools/research/post-draft-r2-plan.mjs','tests/node/post-draft-r2-plan.test.mjs','tools/research/read-post-draft-metadata.mjs'])code[path]=sha(await readFile(path));
 return {...plan,inputs:Object.fromEntries(Object.entries(input).map(([k,v])=>[k,{path:paths[k],sha256:v.sha256}])),
  frozenFiles:Object.fromEntries(Object.entries(boundFiles).map(([k,path])=>[k,{path,sha256:expected[k]}])),code};
}
async function main(){
 const [mode,path,...extra]=process.argv.slice(2);assert(['create','verify'].includes(mode)&&path&&!extra.length);
 let saved;if(mode==='verify')saved=(await json(path)).value;
 const plannedAt=saved?.plannedAt??new Date().toISOString();assert(plannedAt<=new Date().toISOString());
 const body=await prepare(plannedAt),result={...body,fingerprint:digest(body)};
 if(mode==='create')await writeFile(path,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 else assert.equal(digest(result),digest(saved),'plan_changed');
 console.log(JSON.stringify({status:mode==='create'?'registered_development_plan':'verified_development_plan',fingerprint:result.fingerprint,
  exposure:result.exposure,partitions:result.targetLedger.partitions,independentEvaluation:result.independentEvaluation.status,deployable:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{
 console.error(e.code==='EEXIST'?'Протокол уже существует; нужна новая версия.':'Проверка плана R2 не пройдена: проверьте аргументы, метаданные и SHA.');process.exitCode=1;
});
