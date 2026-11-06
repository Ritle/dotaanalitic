import {join} from 'node:path';
import {RetestExecutionConfigSchema,RetestExecutionCapsuleSchema,RetestExecutableFreezeBodySchema,
  RetestExecutableFreezeSchema,RetestEvaluationStartSchema} from '../../packages/contracts/dist/v1-retest-execution.js';
import {V1RetestFilesSchema,V1RetestCaptureIndexSchema,V1RetestAccessReviewSchema} from '../../packages/contracts/dist/v1-retest-protocol.js';
import {V1HistoricalFilesSchema} from '../../packages/contracts/dist/v1-historical-protocol.js';
import {RetestImportManifestSchema} from '../../packages/contracts/dist/v1-retest-import.js';
import {verifyV1Data} from '../../packages/db/dist/v1-data.js';
import {historicalHash,historicalCandidate,scoreHistoricalEvaluation} from './v1-historical-execution.mjs';
import {reconcileHistoricalImport} from './v1-historical-import.mjs';
import {readRetestImportPlan,reconcileRetestImport} from './v1-retest-import.mjs';
import {verifyRetestProtocol,bounded,sha} from './v1-retest-protocol.mjs';

const hash=historicalHash,same=(a,b)=>hash(a)===hash(b),stamp=body=>({...body,fingerprint:hash(body)});
const fail=code=>{throw Error('retest_execution_'+code);};
const clock=at=>{if(typeof at!=='string'||!Number.isFinite(Date.parse(at))||new Date(at).toISOString()!==at)fail('clock');};
const checked=value=>{const {fingerprint,...body}=value;if(hash(body)!==fingerprint)fail('fingerprint');return value;};
const decode=e=>{if(sha(e.text)!==e.sha256)fail('source_sha');return JSON.parse(e.text);};
const evidence=async ref=>({sha256:ref.sha256,text:(await bounded(ref.path,134217728,ref.sha256)).bytes.toString('utf8')});
const keys=['request','proposal','intent','catalogue','fileExposure','databaseExposure','captureIndex','metadataReview','accessReview'];
const priorKeys=['protocol','freeze','started','report','registry'];

/** Every original byte reference is checked again without opening paths from the portable capsule. */
function protocolContext(capsule){
  const sources=new Map(capsule.protocolSources.map(e=>[e.sha256,e])),used=new Set();
  if(sources.size!==capsule.protocolSources.length)fail('duplicate_source');
  const get=ref=>{const e=sources.get(ref?.sha256);if(!e)fail('missing_source');used.add(ref.sha256);return decode(e);};
  const refs=V1RetestFilesSchema.parse(decode(capsule.protocolInputs)),context={refs};
  for(const key of keys)context[key]=get(refs[key]);
  const index=V1RetestCaptureIndexSchema.parse(context.captureIndex);
  if(index.completedAt>context.proposal.checkedAt)fail('capture_clock');
  context.captures=index.captures.map(get);
  get(V1RetestAccessReviewSchema.parse(context.accessReview).evidence);
  const oldRefs=V1HistoricalFilesSchema.parse(get(refs.previous.inputs));
  context.previous={inputs:Object.fromEntries(['request','catalogue','exposure'].map(k=>[k,get(oldRefs[k])]))};
  const oldRequest=context.previous.inputs.request;
  if(oldRequest.catalogueSha256!==oldRefs.catalogue.sha256||oldRequest.exposureSha256!==oldRefs.exposure.sha256)fail('prior_source_binding');
  for(const key of priorKeys)context.previous[key]=get(refs.previous[key]);
  if(used.size!==sources.size)fail('unbound_source');return context;
}

/** Only the production importer can prepare a real capsule, after terminal collection and full raw-source replay. */
export async function prepareRetestCapsule(configPath,digest,preparedAt=new Date().toISOString()){
  clock(preparedAt);if(preparedAt>new Date().toISOString())fail('preparation_clock');
  const config=RetestExecutionConfigSchema.parse((await bounded(configPath,65536,digest)).data);
  const {plan,ctx}=await readRetestImportPlan(config.importPlan.path,config.importPlan.sha256);
  const importConfig=(await bounded(plan.config.path,262144,plan.config.sha256)).data;
  const protocolInputs=await evidence(ctx.config.protocolInputs),refs=V1RetestFilesSchema.parse(decode(protocolInputs)),sources=new Map();
  const add=async ref=>{const e=await evidence(ref);sources.set(e.sha256,e);return decode(e);};
  const inputs={};for(const key of keys)inputs[key]=await add(refs[key]);
  for(const ref of inputs.captureIndex.captures)await add(ref);
  await add(inputs.accessReview.evidence);
  const oldRefs=await add(refs.previous.inputs);for(const key of ['request','catalogue','exposure'])await add(oldRefs[key]);
  for(const key of priorKeys)await add(refs.previous[key]);
  const body={schemaVersion:2,format:'v1-retest-execution-input-v2',preparedAt,protocolInputs,
    protocolSources:[...sources.values()].sort((a,b)=>a.sha256.localeCompare(b.sha256)),protocol:await evidence(ctx.config.protocol),
    closure:await evidence({path:join(ctx.root,'closure.json'),sha256:plan.closureSha256}),
    sourceManifest:await evidence(importConfig.sourceManifest),importPlan:await evidence(config.importPlan),dataset:await evidence(config.dataset)};
  if(!same(plan,decode(body.importPlan)))fail('source_changed');
  const capsule=stamp({...body,coverage:reconcileRetestImport(plan,decode(body.dataset))});
  verifyRetestCapsule(capsule);return capsule;
}

// Synthetic fixtures exercise the same canonical reconciliation; production preparation rejects them upstream.
export function retestExecutionCoverage(plan,dataset){
  if(!plan.syntheticOnly)return reconcileRetestImport(plan,dataset);
  if(!dataset.source?.syntheticOnly||plan.format!=='v1-retest-import-plan-v2'||plan.schemaVersion!==2)fail('synthetic_scope');
  if(dataset.source.candidates.some(m=>plan.historyConflictMapIds.includes(m.matchId)))fail('history_discovery_conflict');
  return {...reconcileHistoricalImport(plan,dataset),schemaVersion:2,format:'v1-retest-canonical-review-v2',
    closureSha256:plan.closureSha256,sourceManifestFingerprint:plan.sourceManifestFingerprint,
    collectionUnavailableSources:plan.collectionReport.unavailableSources};
}

export function verifyRetestCapsule(input){
  const capsule=checked(RetestExecutionCapsuleSchema.parse(input)),inputs=protocolContext(capsule);
  const protocol=verifyRetestProtocol(decode(capsule.protocol),inputs),plan=checked(decode(capsule.importPlan));
  const dataset=verifyV1Data(decode(capsule.dataset)),closure=checked(decode(capsule.closure));
  const manifest=checked(RetestImportManifestSchema.parse(decode(capsule.sourceManifest)));
  if(plan.format!=='v1-retest-import-plan-v2'||plan.schemaVersion!==2||plan.protocolFingerprint!==protocol.fingerprint||
    plan.syntheticOnly!==protocol.syntheticOnly||dataset.source.syntheticOnly!==protocol.syntheticOnly||
    dataset.source.request.fromAt!==protocol.request.warmupFromAt||dataset.source.request.toAt!==protocol.request.eventCutoffAt||
    dataset.source.request.maxMaps!==protocol.request.maxInventoryMaps)fail('scope_binding');
  if(closure.schemaVersion!==2||closure.format!=='retest-collection-closure-v2'||closure.protocolFingerprint!==protocol.fingerprint||
    !closure.report?.collection?.terminal||closure.report.protocolFingerprint!==protocol.fingerprint||
    closure.report.format!=='retest-collection-review-v2'||plan.closureSha256!==capsule.closure.sha256||
    plan.closureFingerprint!==closure.fingerprint||plan.sourceManifestFingerprint!==manifest.fingerprint||
    manifest.closureSha256!==capsule.closure.sha256||manifest.protocolFingerprint!==protocol.fingerprint||
    manifest.stateFingerprint!==closure.stateFingerprint||manifest.configSha256!==closure.configSha256||
    !same(plan.collectionReport,closure.report))fail('closure_binding');
  clock(closure.closedAt);clock(plan.reviewedAt);
  if(closure.reason==='deadline'?closure.closedAt<protocol.collection.collectionDeadline:closure.reason!=='all_work_terminal')fail('closure_reason');
  if(closure.closedAt<protocol.registeredAt||plan.reviewedAt<closure.closedAt||
    dataset.source.request.snapshotAt<closure.closedAt||capsule.preparedAt<plan.reviewedAt||
    capsule.preparedAt<dataset.source.request.snapshotAt)fail('preparation_clock');
  // The closure must retain exactly the pre-registered metadata ledger, including missing and exposed targets.
  const targets=inputs.metadataReview.ledger,rows=plan.collectionReport.rows;
  if(new Set(rows.map(r=>r.matchId)).size!==rows.length||rows.length!==targets.length)fail('target_inventory');
  for(const target of targets){const row=rows.find(r=>r.matchId===target.matchId);
    if(!row||(target.seriesId!==null&&row.seriesId!==target.seriesId)||target.priorExposure&&!row.exposureExcluded||
      target.reasons.some(reason=>!(reason==='SERIES_ID_PENDING'&&row.seriesId!==null)&&!row.reasons.includes(reason)))fail('target_binding');
  }
  const coverage=retestExecutionCoverage(plan,dataset);
  if(!same(capsule.coverage,coverage))fail('coverage_replay');
  if(coverage.rows.some(r=>r.ready&&(r.seriesId===null||r.exposureExcluded)))fail('target_binding');
  const exposedIds=new Set(inputs.fileExposure.potentialMapIds.concat(inputs.databaseExposure.maps.map(r=>r.matchId)));
  const exposedSeries=new Set(inputs.fileExposure.opendotaSeriesIds.concat(inputs.databaseExposure.maps.filter(r=>r.provider==='opendota').map(r=>r.providerSeriesId)));
  for(const row of coverage.rows){
    if(!row.exposureExcluded&&(exposedIds.has(row.matchId)||exposedSeries.has(row.seriesId)||coverage.rows.some(r=>r.seriesId!==null&&r.seriesId===row.seriesId&&r.exposureExcluded)))fail('exposure_binding');
    if(row.ready){const m=dataset.source.candidates.find(m=>m.matchId===row.matchId),t=targets.find(t=>t.matchId===row.matchId);
      if(t.startTime===null||BigInt(m.startedAtUs)!==BigInt(t.startTime)*1000000n||m.radiantTeamId!==t.radiantTeamId||m.direTeamId!==t.direTeamId)fail('target_context');
    }
  }
  historicalCandidate(protocol); // Reject a changed numeric policy before any target is scored.
  return {capsule,protocol,plan,dataset,coverage,inputs};
}

export function registerRetestFreeze(context,capsuleSha256,code,runtime,registeredAt){
  clock(registeredAt);const {capsule,protocol,dataset,coverage}=context;
  if(registeredAt<capsule.preparedAt)fail('registration_clock');
  const required=['scripts/retest-v1.mjs','scripts/lib/v1-retest-execution.mjs','scripts/lib/v1-retest-bundle.mjs',
    'scripts/lib/v1-historical-execution.mjs','packages/contracts/dist/v1-retest-execution.js',
    'packages/prediction/dist/v1-features.js','packages/prediction/dist/v1-candidate.js','packages/prediction/dist/v1-quality.js'];
  if(required.some(path=>!code.some(row=>row.path===path)))fail('code_missing');
  return stamp(RetestExecutableFreezeBodySchema.parse({schemaVersion:2,format:'v1-retest-executable-freeze-v2',registeredAt,
    capsuleSha256,capsuleFingerprint:capsule.fingerprint,protocolSha256:capsule.protocol.sha256,protocolFingerprint:protocol.fingerprint,
    datasetSha256:capsule.dataset.sha256,datasetFingerprint:dataset.fingerprint,importPlanSha256:capsule.importPlan.sha256,
    closureSha256:capsule.closure.sha256,sourceManifestSha256:capsule.sourceManifest.sha256,previousReportSha256:protocol.previousAttempt.reportSha256,
    qualityPolicySha256:protocol.qualityPolicySha256,candidateFingerprint:historicalCandidate(protocol).fingerprint,
    targetLedgerFingerprint:hash(coverage.rows),code:[...code].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),runtime,
    syntheticOnly:protocol.syntheticOnly,evaluator:'v1-retest-evaluation-v2',registry:'v1-retest-registry-binding-v2',
    evaluationBasis:protocol.request.evaluationBasis,complete:true,activation:'separate_gate_required'}));
}
export function verifyRetestFreeze(saved,context,capsuleSha256,code,runtime){
  const parsed=RetestExecutableFreezeSchema.parse(saved),rebuilt=registerRetestFreeze(context,capsuleSha256,code,runtime,parsed.registeredAt);
  if(!same(parsed,rebuilt))fail('freeze_replay');return rebuilt;
}
export function scoreRetestEvaluation(context,freeze,freezeSha256,startInput){
  const start=RetestEvaluationStartSchema.parse(startInput);
  // Adapt only the call to the immutable arithmetic kernel. The registered v2 protocol is never rewritten.
  const protocol={...context.protocol,request:{...context.protocol.request,
    baseQualityPolicySha256:context.inputs.previous.protocol.request.baseQualityPolicySha256}};
  const kernel=scoreHistoricalEvaluation({...context,protocol},freeze,freezeSha256,
    {...start,schemaVersion:1,format:'v1-historical-first-scoring-v1'});
  const {fingerprint,...body}=kernel;
  return stamp({...body,schemaVersion:2,format:'v1-retest-evaluation-v2',firstScoring:start,
    closureSha256:freeze.closureSha256,sourceManifestSha256:freeze.sourceManifestSha256,
    previousAttempt:context.protocol.previousAttempt,kernel:'unchanged_v1_historical_arithmetic'});
}
export function retestRegistryBinding(context,freeze,freezeSha256,report){
  checked(report);if(!same(report,scoreRetestEvaluation(context,freeze,freezeSha256,report.firstScoring)))fail('evaluation_replay');
  return stamp({schemaVersion:2,format:'v1-retest-registry-binding-v2',freezeSha256,freezeFingerprint:freeze.fingerprint,
    protocolFingerprint:freeze.protocolFingerprint,datasetFingerprint:freeze.datasetFingerprint,
    candidateFingerprint:freeze.candidateFingerprint,evaluationFingerprint:report.fingerprint,
    closureSha256:freeze.closureSha256,previousReportSha256:freeze.previousReportSha256,
    evaluationBasis:freeze.evaluationBasis,qualityPolicySha256:freeze.qualityPolicySha256,
    qualityDecision:report.qualityDecision,eligibleForActivation:report.releaseGatePassed,
    activation:'separate_gate_required',legacyRegistryCompatible:false,isActive:false,deployable:false,teamAWinProbability:null});
}
