import {V1HistoricalRequestSchema,V1HistoricalExposureSchema,V1HistoricalFilesSchema,
  V1HistoricalDiscoveryCaptureSchema,V1HistoricalDiscoveryFilesSchema} from '../../packages/contracts/dist/v1-historical-protocol.js';
import {V1ReleaseCatalogueRowsSchema} from '../../packages/contracts/dist/v1-release-plan.js';
import {V1ReleaseRevisionCatalogueSchema} from '../../packages/contracts/dist/v1-release-revision.js';
import {EvaluationDiscoveryRowsSchema} from '../../packages/contracts/dist/evaluation-discovery.js';
import {V1_RELEASE_QUALITY_POLICY} from '../../packages/prediction/dist/v1-quality-policy.js';
import {canonicalContextJson} from '../../packages/db/dist/temporal.js';
import {bounded,save,sha} from './evaluation-discovery-files.mjs';

const hash=value=>sha(canonicalContextJson(value));
const fail=code=>{throw Error('historical_'+code);};
const parse=(schema,value,code)=>{const p=schema.safeParse(value);if(!p.success)fail(code);return p.data;};
const clock=at=>{if(!Number.isFinite(Date.parse(at))||new Date(at).toISOString()!==at)fail('clock_invalid');};
const numeric=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;

export function registerHistoricalProtocol(requestInput,catalogueInput,exposureInput,registeredAt){
  clock(registeredAt);
  const request=parse(V1HistoricalRequestSchema,requestInput,'request_invalid');
  const catalogue=parse(V1ReleaseRevisionCatalogueSchema,catalogueInput,'catalogue_invalid');
  const exposure=parse(V1HistoricalExposureSchema,exposureInput,'exposure_invalid');
  if(request.baseQualityPolicySha256!==hash(V1_RELEASE_QUALITY_POLICY))fail('base_policy_changed');
  if(sha(catalogue.rawBody)!==catalogue.source.payloadSha256)fail('catalogue_payload_hash');
  if(request.eventCutoffAt>registeredAt||exposure.capturedAt>registeredAt||catalogue.source.fetchedAt>registeredAt||
    request.events.some(e=>e.until>registeredAt||e.tierDecision.reviewedAt>registeredAt))fail('future_evidence');
  if(Date.parse(registeredAt)-Date.parse(catalogue.source.fetchedAt)>86400000)fail('catalogue_stale');
  let rows;try{rows=V1ReleaseCatalogueRowsSchema.parse(JSON.parse(catalogue.rawBody));}catch{fail('catalogue_invalid');}
  for(const event of request.events){
    const found=rows.filter(r=>r.leagueid===event.leagueId);
    if(found.length!==1||found[0].name!==event.catalogueName||!['professional','premium'].includes(found[0].tier))fail('event_binding');
  }
  const qualityPolicy=structuredClone(V1_RELEASE_QUALITY_POLICY);
  qualityPolicy.version='conditional-elo-tier1-historical-v1';
  qualityPolicy.selection.target='all_observed_unexposed_whole_series_in_registered_event_windows';
  qualityPolicy.sample.mapCoverageDenominator='all_unexposed_target_ids_including_pending_or_ineligible_metadata';
  qualityPolicy.sample.seriesCoverageDenominator='all_unexposed_target_known_series_including_ineligible';
  qualityPolicy.decision.executableFreeze='before_first_model_scoring_with_historical_protocol_and_exposure_manifest';
  const body={schemaVersion:1,format:'v1-historical-protocol-v1',registeredAt,request,
    catalogueEvidence:catalogue.source,catalogueContentFingerprint:hash(catalogue),exposure:{capturedAt:exposure.capturedAt,contentFingerprint:hash(exposure),
      fileManifestSha256:exposure.fileManifestSha256,databaseSnapshotSha256:exposure.databaseSnapshotSha256,
      declaredFileCount:exposure.declaredFileCount,blockedMatchIds:exposure.blockedMatchIds.length,
      knownOpendotaSeries:exposure.opendotaSeriesIds.length,limitations:exposure.limitations},
    qualityPolicy,qualityPolicySha256:hash(qualityPolicy),
    independence:{basis:'before_model_scoring_not_before_historical_event',selection:'exclude_whole_series_if_any_prior_map_or_provider_series_exposed',
      publicHistoricalResultsMayBeKnown:true,sourceAuditMayInspectStructureButNotModelErrors:true,
      noTuningOrFittedCalibration:true,additionalExclusionsAfterScoring:'forbidden',
      unknownSeries:'pending_until_detail_binding_not_silently_clean',coverageIncludesNonExposureQualityFailures:true,
      exposureExclusionsReportedSeparately:true},
    status:'historical_protocol_registered_not_evaluated',syntheticOnly:exposure.syntheticOnly,
    executableFreezeRegistered:false,registryCompatible:false,evaluation:null,teamAWinProbability:null,deployable:false};
  return {...body,fingerprint:hash(body)};
}

export function verifyHistoricalProtocol(saved,catalogue,exposure,expectedRequest=saved?.request){
  if(saved?.format!=='v1-historical-protocol-v1')fail('protocol_format');
  if(canonicalContextJson(saved.request)!==canonicalContextJson(expectedRequest))fail('request_binding');
  const rebuilt=registerHistoricalProtocol(saved.request,catalogue,exposure,saved.registeredAt);
  if(canonicalContextJson(saved)!==canonicalContextJson(rebuilt))fail('protocol_replay');
  return rebuilt;
}

/** Metadata-only classification. Labels/performance fields never enter this ledger. */
export function inspectHistoricalDiscovery(plan,catalogue,exposureInput,capturesInput,checkedAt){
  verifyHistoricalProtocol(plan,catalogue,exposureInput);clock(checkedAt);
  if(checkedAt<plan.registeredAt)fail('clock_before_registration');
  const exposure=parse(V1HistoricalExposureSchema,exposureInput,'exposure_invalid');
  const exposedMaps=new Set(exposure.blockedMatchIds),exposedSeries=new Set(exposure.opendotaSeriesIds);
  const rows=new Map(),seenEvents=new Set(),sources=[];let duplicates=0;
  for(const input of capturesInput){
    const capture=parse(V1HistoricalDiscoveryCaptureSchema,input,'discovery_invalid');
    const event=plan.request.events.find(e=>capture.source.endpoint===`/leagues/${e.leagueId}/matches`);
    if(!event)fail('discovery_endpoint');
    if(capture.source.fetchedAt<plan.registeredAt||capture.source.fetchedAt>checkedAt)fail('discovery_clock');
    if(sha(capture.rawBody)!==capture.source.payloadSha256)fail('discovery_hash');
    let parsed;try{parsed=EvaluationDiscoveryRowsSchema.parse(JSON.parse(capture.rawBody));}catch{fail('discovery_invalid');}
    seenEvents.add(event.eventKey);sources.push(capture.source);
    for(const item of parsed){
      if(item.leagueid!=null&&item.leagueid!==event.leagueId)fail('discovery_league_conflict');
      const row={matchId:item.match_id,leagueId:event.leagueId,eventKey:event.eventKey,
        startTime:item.start_time??null,providerSeriesId:item.series_id??null,
        radiantTeamId:item.radiant_team_id??null,direTeamId:item.dire_team_id??null};
      const prior=rows.get(row.matchId);
      if(prior){if(canonicalContextJson(prior)!==canonicalContextJson(row))fail('discovery_map_conflict');duplicates++;}
      else rows.set(row.matchId,row);
    }
  }
  if(rows.size>plan.request.maxInventoryMaps)fail('inventory_overflow');
  const bySeries=new Map();
  for(const row of rows.values())if(row.providerSeriesId){const group=bySeries.get(row.providerSeriesId)??[];group.push(row);bySeries.set(row.providerSeriesId,group);}
  const hasPrior=row=>exposedMaps.has(row.matchId)||row.providerSeriesId!==null&&exposedSeries.has(row.providerSeriesId);
  const outside=row=>{const e=plan.request.events.find(e=>e.eventKey===row.eventKey);return row.startTime!==null&&
    (row.startTime*1000<Date.parse(e.fromAt)||row.startTime*1000>=Date.parse(e.until));};
  const ledger=[...rows.values()].sort((a,b)=>numeric(a.matchId,b.matchId)).map(row=>{
    const group=row.providerSeriesId?bySeries.get(row.providerSeriesId):[row];
    const exposureExcluded=group.some(hasPrior),reasons=[];
    if(exposureExcluded)reasons.push('PRIOR_EXPOSURE_WHOLE_SERIES');
    if(row.providerSeriesId===null)reasons.push('SERIES_ID_PENDING');
    if(group.some(r=>r.startTime===null))reasons.push('START_TIME_PENDING');
    if(group.some(outside))reasons.push('SERIES_OUTSIDE_WINDOW');
    const pair=r=>r.radiantTeamId&&r.direTeamId?[r.radiantTeamId,r.direTeamId].sort(numeric).join(':'):null;
    if(group.some(r=>pair(r)===null||r.radiantTeamId===r.direTeamId))reasons.push('TEAM_CONTEXT_PENDING');
    if(new Set(group.map(r=>r.leagueId)).size>1||new Set(group.map(pair).filter(Boolean)).size>1)reasons.push('SERIES_CONTEXT_CONFLICT');
    return {...row,inTargetWindow:row.startTime===null?null:!outside(row),exposureExcluded,reasons,metadataCandidate:reasons.length===0};
  });
  const countSeries=filter=>new Set(ledger.filter(filter).flatMap(r=>r.providerSeriesId?[r.providerSeriesId]:[])).size;
  return {schemaVersion:1,format:'v1-historical-discovery-review-v1',protocolFingerprint:plan.fingerprint,checkedAt,sources,
    missingEvents:plan.request.events.filter(e=>!seenEvents.has(e.eventKey)).map(e=>e.eventKey),duplicates,ledger,
    summary:{observedMaps:ledger.length,targetWindowMaps:ledger.filter(r=>r.inTargetWindow===true).length,
      knownSeries:countSeries(()=>true),priorExposedMaps:ledger.filter(r=>r.exposureExcluded).length,
      priorExposedSeries:countSeries(r=>r.exposureExcluded),unexposedObservedMaps:ledger.filter(r=>!r.exposureExcluded).length,
      unexposedTargetMaps:ledger.filter(r=>!r.exposureExcluded&&r.inTargetWindow!==false).length,
      metadataCandidateMaps:ledger.filter(r=>r.metadataCandidate).length,metadataCandidateSeries:countSeries(r=>r.metadataCandidate),
      unresolvedMaps:ledger.filter(r=>!r.exposureExcluded&&!r.metadataCandidate).length},
    providerCompleteness:'unknown',eligibilityVerified:false,coverageGateCalculated:false,evaluationPerformed:false,
    teamAWinProbability:null,metrics:null,deployable:false};
}

export async function readHistoricalInputs(path,expectedSha){
  const config=parse(V1HistoricalFilesSchema,(await bounded(path,65536,expectedSha)).data,'config_invalid');
  const request=await bounded(config.request.path,65536,config.request.sha256);
  const catalogue=await bounded(config.catalogue.path,16777216,config.catalogue.sha256);
  const exposure=await bounded(config.exposure.path,33554432,config.exposure.sha256);
  if(request.data.catalogueSha256!==config.catalogue.sha256||request.data.exposureSha256!==config.exposure.sha256)fail('source_binding');
  return {request:request.data,catalogue:catalogue.data,exposure:exposure.data};
}
export async function readHistoricalCaptures(path,expectedSha){
  const config=parse(V1HistoricalDiscoveryFilesSchema,(await bounded(path,65536,expectedSha)).data,'capture_config');
  const captures=[];for(const ref of config.captures)captures.push((await bounded(ref.path,16777216,ref.sha256)).data);
  return captures;
}
export {save,sha,bounded};
