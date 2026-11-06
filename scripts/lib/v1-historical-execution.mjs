import {HistoricalExecutionConfigSchema,HistoricalExecutionCapsuleSchema,HistoricalExecutableFreezeBodySchema,
  HistoricalExecutableFreezeSchema,HistoricalEvaluationStartSchema} from '../../packages/contracts/dist/v1-historical-execution.js';
import {verifyV1Data} from '../../packages/db/dist/v1-data.js';
import {prepareV1PerMapFeatureHistory} from '../../packages/db/dist/v1-features.js';
import {createV1FeatureBuilder,V1_FEATURE_POLICY} from '../../packages/prediction/dist/v1-features.js';
import {eloLink} from '../../packages/prediction/dist/v1-candidate.js';
import {evaluateV1MetricDiagnostic} from '../../packages/prediction/dist/v1-quality.js';
import {V1_RELEASE_QUALITY_POLICY} from '../../packages/prediction/dist/v1-quality-policy.js';
import {canonicalContextJson} from '../../packages/db/dist/temporal.js';
import {readHistoricalImportPlan,reconcileHistoricalImport} from './v1-historical-import.mjs';
import {verifyHistoricalProtocol,bounded,sha} from './v1-historical-protocol.mjs';

export const historicalHash=value=>sha(canonicalContextJson(value));
const same=(a,b)=>canonicalContextJson(a)===canonicalContextJson(b);
const fail=reason=>{throw Error('historical_execution_'+reason);};
const clock=at=>{if(typeof at!=='string'||!Number.isFinite(Date.parse(at))||new Date(at).toISOString()!==at)fail('clock');};
const stamp=body=>({...body,fingerprint:historicalHash(body)});
function checked(input){const {fingerprint,...body}=input;if(historicalHash(body)!==fingerprint)fail('fingerprint');return input;}
function decode(evidence){if(sha(evidence.text)!==evidence.sha256)fail('source_sha');return JSON.parse(evidence.text);}
async function evidence(ref,max=67108864){const f=await bounded(ref.path,max,ref.sha256);return {sha256:ref.sha256,text:f.bytes.toString('utf8')};}

/** Full original-source replay is performed once before freezing this canonical, portable input. */
export async function prepareHistoricalCapsule(configPath,digest,preparedAt=new Date().toISOString()){
  clock(preparedAt);
  const config=HistoricalExecutionConfigSchema.parse((await bounded(configPath,65536,digest)).data);
  const {plan,ctx}=await readHistoricalImportPlan(config.importPlan.path,config.importPlan.sha256);
  const inputs=(await bounded(ctx.config.protocolInputs.path,65536,ctx.config.protocolInputs.sha256)).data;
  const body={schemaVersion:1,format:'v1-historical-execution-input-v1',preparedAt,
    protocol:await evidence(ctx.config.protocol),catalogue:await evidence(inputs.catalogue),exposure:await evidence(inputs.exposure),
    importPlan:await evidence(config.importPlan),dataset:await evidence(config.dataset)};
  if(!same(plan,decode(body.importPlan)))fail('source_changed');
  const capsule=stamp({...body,coverage:reconcileHistoricalImport(plan,decode(body.dataset))});
  verifyHistoricalCapsule(capsule);return capsule;
}

export function verifyHistoricalCapsule(input){
  const capsule=checked(HistoricalExecutionCapsuleSchema.parse(input)),catalogue=decode(capsule.catalogue),exposure=decode(capsule.exposure);
  const protocol=verifyHistoricalProtocol(decode(capsule.protocol),catalogue,exposure),plan=checked(decode(capsule.importPlan));
  const dataset=verifyV1Data(decode(capsule.dataset));
  if(protocol.request.catalogueSha256!==capsule.catalogue.sha256||protocol.request.exposureSha256!==capsule.exposure.sha256||
    plan.format!=='v1-historical-import-plan-v1'||plan.protocolFingerprint!==protocol.fingerprint||
    plan.collectionReport.protocolFingerprint!==protocol.fingerprint||plan.syntheticOnly!==protocol.syntheticOnly||
    dataset.source.syntheticOnly!==protocol.syntheticOnly||dataset.source.request.fromAt!==protocol.request.warmupFromAt||
    dataset.source.request.toAt!==protocol.request.eventCutoffAt)fail('scope_binding');
  if(capsule.preparedAt<protocol.registeredAt||capsule.preparedAt<plan.reviewedAt||
    capsule.preparedAt<dataset.source.request.snapshotAt)fail('preparation_clock');
  const coverage=reconcileHistoricalImport(plan,dataset);
  if(!same(capsule.coverage,coverage))fail('coverage_replay');
  if(new Set(coverage.rows.map(r=>r.matchId)).size!==coverage.rows.length)fail('duplicate_target');
  const exposedIds=new Set(exposure.blockedMatchIds),exposedSeries=new Set(exposure.opendotaSeriesIds);
  for(const row of coverage.rows){
    if(!row.exposureExcluded&&(exposedIds.has(row.matchId)||exposedSeries.has(row.seriesId)||
      coverage.rows.some(s=>s.seriesId!==null&&s.seriesId===row.seriesId&&s.exposureExcluded)))fail('exposure_binding');
    if(row.ready){
      const original=plan.collectionReport.rows.find(r=>r.matchId===row.matchId);
      if(original?.exposureExcluded||row.seriesId===null)fail('target_binding');
    }
  }
  return {capsule,protocol,plan,dataset,coverage};
}

/** Fixed policy only, with shared TS inference arithmetic. No historical map is scored here. */
export function historicalCandidate(protocol){
  const q=protocol.qualityPolicy;
  for(const key of ['model','history','scoring','calibration','uncertainty','stability'])
    if(!same(q[key],V1_RELEASE_QUALITY_POLICY[key]))fail('numeric_policy_changed');
  if(V1_FEATURE_POLICY.k!==q.model.k||V1_FEATURE_POLICY.initialRating!==q.model.initialRating||
    V1_FEATURE_POLICY.scale!==q.model.scale||V1_FEATURE_POLICY.version!==q.model.featureProfile||
    V1_FEATURE_POLICY.minCompletedProMapsPerPlayer!==q.history.minCompletedProMapsPerPlayer)fail('feature_policy_changed');
  const probes=[[-800,1/101],[-400,1/11],[0,0.5],[400,10/11],[800,100/101]];
  if(probes.some(([x,y])=>Math.abs(eloLink(x)-y)>1e-14))fail('arithmetic_parity');
  return stamp({schemaVersion:1,format:'v1-historical-fixed-elo-candidate-v1',stage:'pre_match',model:'fixed_player_mean_elo',
    protocolFingerprint:protocol.fingerprint,qualityPolicySha256:protocol.qualityPolicySha256,
    featurePolicy:V1_FEATURE_POLICY,inference:{featureOrder:['eloDifference'],link:'base10_elo_logistic',scale:400,
      preprocessing:'none',fittedCalibrator:false,sideAdvantage:false},
    fit:'fixed_policy_no_fitting',parity:{purpose:'synthetic_arithmetic_probes_only',absoluteTolerance:1e-14,probes},
    isActive:false,deployable:false,teamAWinProbability:null});
}

export function registerHistoricalFreeze(context,capsuleSha256,code,runtime,registeredAt){
  clock(registeredAt);
  const {capsule,protocol,dataset,coverage}=context,candidate=historicalCandidate(protocol);
  if(registeredAt<capsule.preparedAt)fail('registration_clock');
  const required=['scripts/historical-v1.mjs','scripts/lib/v1-historical-execution.mjs','scripts/lib/v1-historical-bundle.mjs',
    'packages/prediction/dist/v1-features.js','packages/prediction/dist/v1-candidate.js','packages/prediction/dist/v1-quality.js'];
  if(required.some(path=>!code.some(row=>row.path===path)))fail('code_missing');
  const body=HistoricalExecutableFreezeBodySchema.parse({schemaVersion:1,format:'v1-historical-executable-freeze-v1',registeredAt,
    capsuleSha256,capsuleFingerprint:capsule.fingerprint,protocolSha256:capsule.protocol.sha256,protocolFingerprint:protocol.fingerprint,
    datasetSha256:capsule.dataset.sha256,datasetFingerprint:dataset.fingerprint,importPlanSha256:capsule.importPlan.sha256,
    qualityPolicySha256:protocol.qualityPolicySha256,candidateFingerprint:candidate.fingerprint,
    targetLedgerFingerprint:historicalHash(coverage.rows),code:[...code].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),runtime,
    syntheticOnly:protocol.syntheticOnly,evaluator:'v1-historical-evaluation-v1',registry:'v1-historical-registry-binding-v1',
    evaluationBasis:protocol.request.evaluationBasis,complete:true,activation:'separate_gate_required'});
  return stamp(body);
}
export function verifyHistoricalFreeze(saved,context,capsuleSha256,code,runtime){
  const parsed=HistoricalExecutableFreezeSchema.parse(saved),rebuilt=registerHistoricalFreeze(context,capsuleSha256,code,runtime,parsed.registeredAt);
  if(!same(parsed,rebuilt))fail('freeze_replay');return rebuilt;
}

/** Test ledger remains fixed; outcome-dependent arithmetic begins only after a durable first-scoring receipt. */
export function scoreHistoricalEvaluation(context,freeze,freezeSha256,startInput){
  const start=HistoricalEvaluationStartSchema.parse(startInput),{protocol,dataset,coverage}=context;
  if(start.freezeSha256!==freezeSha256||start.freezeFingerprint!==freeze.fingerprint||start.capsuleSha256!==freeze.capsuleSha256||
    start.startedAt<freeze.registeredAt||freeze.protocolFingerprint!==protocol.fingerprint||
    freeze.datasetFingerprint!==dataset.fingerprint||freeze.targetLedgerFingerprint!==historicalHash(coverage.rows))fail('scoring_binding');
  const history=prepareV1PerMapFeatureHistory(dataset.source),build=createV1FeatureBuilder(history);
  const byId=new Map(history.maps.map(m=>[m.matchId,m])),canonical=new Map(dataset.source.candidates.map(m=>[m.matchId,m]));
  const ledger=coverage.rows.filter(r=>!r.exposureExcluded).map(r=>({matchId:r.matchId,seriesKey:r.seriesId===null?null:`opendota:${r.seriesId}`,
    disposition:r.ready?'scored':'excluded',reasons:[...r.reasons]}));
  const scores=[],features=[];
  for(const row of ledger){
    if(row.disposition!=='scored')continue;
    const m=byId.get(row.matchId),raw=canonical.get(row.matchId);
    if(!m||m.seriesKey!==row.seriesKey||!raw?.radiantTeamId||!raw.direTeamId)fail('target_binding');
    const isRadiant=BigInt(raw.radiantTeamId)<BigInt(raw.direTeamId);
    const scenario={schemaVersion:1,cutoffAtUs:m.startedAtUs,targetMatchId:m.matchId,
      teamA:isRadiant?m.teamA:m.teamB,teamB:isRadiant?m.teamB:m.teamA,
      lineup:{basis:'actual_lineup_reconstructed',source:'verified-map-receipt:'+m.outcomeReceiptId,
        selectedAtUs:m.fetchedAtUs,revision:dataset.fingerprint}};
    const result=build(scenario);
    if(result.status!=='ready')fail('frozen_target_unavailable'); // Never silently drop a target after scoring starts.
    if(result.history.usedMatchIds.some(id=>{const used=byId.get(id);return !used||id===m.matchId||
      BigInt(used.startedAtUs)>=BigInt(m.startedAtUs)||BigInt(used.completedAtUs)>=BigInt(m.startedAtUs);}))fail('history_cutoff');
    scores.push({matchId:m.matchId,seriesKey:m.seriesKey,startedAtUs:m.startedAtUs,
      probability:eloLink(result.features.eloDifference),teamAWon:isRadiant?m.teamAWon:!m.teamAWon});
    features.push({matchId:m.matchId,teamAId:isRadiant?raw.radiantTeamId:raw.direTeamId,
      teamBId:isRadiant?raw.direTeamId:raw.radiantTeamId,result});
  }
  const metric=evaluateV1MetricDiagnostic({schemaVersion:1,purpose:'unbound_metric_diagnostic',syntheticOnly:protocol.syntheticOnly,ledger,rows:scores});
  if(metric.qualityPolicySha256!==protocol.request.baseQualityPolicySha256)fail('metric_policy_changed');
  const releaseGatePassed=metric.metricGateDecision==='passed'&&!protocol.syntheticOnly;
  return stamp({schemaVersion:1,format:'v1-historical-evaluation-v1',freezeSha256,freezeFingerprint:freeze.fingerprint,
    capsuleSha256:freeze.capsuleSha256,protocolFingerprint:protocol.fingerprint,datasetFingerprint:dataset.fingerprint,
    candidateFingerprint:freeze.candidateFingerprint,targetLedgerFingerprint:freeze.targetLedgerFingerprint,
    qualityPolicySha256:protocol.qualityPolicySha256,firstScoring:start,scorerCode:freeze.code,
    evaluationBasis:protocol.request.evaluationBasis,exposureExcludedMaps:coverage.rows.filter(r=>r.exposureExcluded).length,
    ledger,rows:scores,features,metricDiagnostic:metric,
    qualityDecision:metric.metricGateDecision,releaseGatePassed,
    limitations:[...protocol.exposure.limitations,'PUBLIC_HISTORICAL_RESULTS_MAY_BE_KNOWN','EVENT_TIME_OUTCOME_AVAILABILITY_ASSUMED',
      'CURRENT_NUMERIC_IDENTITIES','RECONSTRUCTED_LINEUP_NOT_PROSPECTIVE','REMOTE_HISTORY_COMPLETENESS_UNKNOWN'],
    syntheticOnly:protocol.syntheticOnly,deployable:false,isActive:false,teamAWinProbability:null});
}

/** Registry handoff is computed from replayed metrics, never caller-supplied passed=true. Activation is separate. */
export function historicalRegistryBinding(context,freeze,freezeSha256,report){
  checked(report);
  const replay=scoreHistoricalEvaluation(context,freeze,freezeSha256,report.firstScoring);
  if(!same(report,replay))fail('evaluation_replay');
  return stamp({schemaVersion:1,format:'v1-historical-registry-binding-v1',freezeSha256,freezeFingerprint:freeze.fingerprint,
    protocolFingerprint:freeze.protocolFingerprint,datasetFingerprint:freeze.datasetFingerprint,
    candidateFingerprint:freeze.candidateFingerprint,evaluationFingerprint:report.fingerprint,
    evaluationBasis:freeze.evaluationBasis,qualityPolicySha256:freeze.qualityPolicySha256,
    qualityDecision:report.qualityDecision,eligibleForActivation:report.releaseGatePassed,
    activation:'separate_gate_required',legacyRegistryCompatible:false,isActive:false,deployable:false,teamAWinProbability:null});
}
