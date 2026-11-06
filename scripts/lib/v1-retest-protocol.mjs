import {V1RetestRequestSchema,V1RetestFilesSchema,V1RetestIntentSchema,V1RetestProposalSchema,
  V1RetestFileExposureSchema,V1RetestDatabaseExposureSchema,V1RetestCaptureIndexSchema,V1RetestAccessReviewSchema} from '../../packages/contracts/dist/v1-retest-protocol.js';
import {V1HistoricalDiscoveryCaptureSchema} from '../../packages/contracts/dist/v1-historical-protocol.js';
import {V1ReleaseCatalogueRowsSchema,V1ReleaseCatalogueCaptureSchema} from '../../packages/contracts/dist/v1-release-plan.js';
import {EvaluationDiscoveryRowsSchema} from '../../packages/contracts/dist/evaluation-discovery.js';
import {canonicalContextJson} from '../../packages/db/dist/temporal.js';
import {verifyHistoricalProtocol,readHistoricalInputs,bounded,save,sha} from './v1-historical-protocol.mjs';

const fail=code=>{throw Error('retest_'+code);};
const parse=(schema,value,code)=>{const r=schema.safeParse(value);if(!r.success)fail(code);return r.data;};
const same=(a,b)=>canonicalContextJson(a)===canonicalContextJson(b);
const hash=v=>sha(canonicalContextJson(v));
const clock=at=>{if(!Number.isFinite(Date.parse(at))||new Date(at).toISOString()!==at)fail('clock_invalid');};
const numeric=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const stamp=body=>({...body,fingerprint:hash(body)});
const checked=value=>{if(!value||typeof value!=='object')fail('prior_fingerprint');const {fingerprint,...body}=value;if(hash(body)!==fingerprint)fail('prior_fingerprint');};

/** Metadata only: performance/labels are removed at the Zod boundary. */
export function retestMetadata(intent,exposure,captures,checkedAt){
  const rows=new Map(),seen=new Set(),sources=[];let duplicates=0;
  const blocked=new Set(exposure.blockedMatchIds),blockedSeries=new Set(exposure.opendotaSeriesIds);
  for(const value of captures){
    const c=parse(V1HistoricalDiscoveryCaptureSchema,value,'discovery_invalid');
    const e=intent.events.find(e=>c.source.endpoint===`/leagues/${e.leagueId}/matches`);
    if(!e||seen.has(e.leagueId))fail('discovery_event');seen.add(e.leagueId);
    if(c.source.fetchedAt<=intent.createdAt||c.source.fetchedAt<=exposure.capturedAt||c.source.fetchedAt>checkedAt)fail('discovery_clock');
    if(sha(c.rawBody)!==c.source.payloadSha256)fail('discovery_hash');
    let data;try{data=EvaluationDiscoveryRowsSchema.parse(JSON.parse(c.rawBody));}catch{fail('discovery_invalid');}
    sources.push(c.source);
    for(const r of data){
      if(r.leagueid!==null&&r.leagueid!==e.leagueId)fail('discovery_league');
      const row={matchId:r.match_id,leagueId:e.leagueId,startTime:r.start_time,seriesId:r.series_id,
        radiantTeamId:r.radiant_team_id,direTeamId:r.dire_team_id};
      const old=rows.get(row.matchId);if(old){if(!same(old,row))fail('discovery_conflict');duplicates++;}else rows.set(row.matchId,row);
    }
  }
  if(seen.size!==intent.events.length)fail('discovery_missing_event');
  if(rows.size>intent.limits.maxUniqueMaps)fail('inventory_overflow');
  const series=Map.groupBy([...rows.values()],r=>r.seriesId??`unknown:${r.matchId}`),ledger=[];
  const outside=r=>{const e=intent.events.find(e=>e.leagueId===r.leagueId);return r.startTime!==null&&
    (r.startTime*1000<Date.parse(e.fromAt)||r.startTime*1000>=Date.parse(e.until));};
  for(const group of series.values()){
    const prior=group.some(r=>blocked.has(r.matchId)||blockedSeries.has(r.seriesId)),reasons=[];
    if(prior)reasons.push('PRIOR_EXPOSURE_WHOLE_SERIES');
    if(group.some(r=>r.seriesId===null))reasons.push('SERIES_ID_PENDING');
    if(group.some(r=>r.startTime===null))reasons.push('START_TIME_PENDING');
    if(group.some(outside))reasons.push('SERIES_OUTSIDE_WINDOW');
    const pairs=group.map(r=>r.radiantTeamId&&r.direTeamId?[r.radiantTeamId,r.direTeamId].sort(numeric).join(':'):null);
    if(pairs.includes(null)||group.some(r=>r.radiantTeamId===r.direTeamId))reasons.push('TEAM_CONTEXT_PENDING');
    if(new Set(group.map(r=>r.leagueId)).size>1||new Set(pairs.filter(Boolean)).size>1)reasons.push('SERIES_CONTEXT_CONFLICT');
    for(const r of group)ledger.push({...r,priorExposure:prior,outsideWindow:outside(r),reasons,metadataCandidate:reasons.length===0});
  }
  ledger.sort((a,b)=>numeric(a.matchId,b.matchId));
  const count=rs=>({maps:rs.length,knownSeries:new Set(rs.flatMap(r=>r.seriesId?[r.seriesId]:[])).size});
  const summary={observed:count(ledger),priorExposed:count(ledger.filter(r=>r.priorExposure)),
    metadataCandidates:count(ledger.filter(r=>r.metadataCandidate)),unresolved:count(ledger.filter(r=>!r.priorExposure&&!r.metadataCandidate)),
    outOfWindow:count(ledger.filter(r=>r.outsideWindow)),missingSeriesMaps:ledger.filter(r=>r.seriesId===null).length};
  // Unknown start/series and other quality failures remain in the denominator.
  const targets=ledger.filter(r=>!r.priorExposure&&!r.outsideWindow);
  return {schemaVersion:2,format:'v1-retest-metadata-review-v2',sources,duplicates,ledger,summary,
    denominator:{...count(targets),unknownSeriesMaps:targets.filter(r=>r.seriesId===null).length},
    providerCompleteness:'unknown',eligibilityVerified:false,evaluationPerformed:false,metrics:null,teamAWinProbability:null};
}

function previousFailure(ctx,intent,proposal){
  const {protocol,inputs,freeze,started,report,registry}=ctx.previous;
  verifyHistoricalProtocol(protocol,inputs.catalogue,inputs.exposure,inputs.request);
  for(const x of [freeze,report,registry])checked(x);
  if(freeze.format!=='v1-historical-executable-freeze-v1'||report.format!=='v1-historical-evaluation-v1'||
    registry.format!=='v1-historical-registry-binding-v1'||started.format!=='v1-historical-first-scoring-v1')fail('prior_format');
  if(report.qualityDecision!=='failed'||report.releaseGatePassed!==false||registry.qualityDecision!=='failed'||
    registry.eligibleForActivation!==false||registry.isActive!==false||registry.deployable!==false)fail('prior_not_failed');
  const refs=ctx.refs.previous;
  if(proposal.pilotReport.sha256!==refs.report.sha256||intent.priorReport.sha256!==refs.report.sha256)fail('prior_report_binding');
  if(freeze.protocolSha256!==refs.protocol.sha256||freeze.protocolFingerprint!==protocol.fingerprint||
    freeze.qualityPolicySha256!==protocol.qualityPolicySha256||report.freezeSha256!==refs.freeze.sha256||
    !same(report.firstScoring,started)||registry.freezeSha256!==refs.freeze.sha256||
    registry.evaluationFingerprint!==report.fingerprint||started.freezeSha256!==refs.freeze.sha256||
    started.freezeFingerprint!==freeze.fingerprint||started.capsuleSha256!==freeze.capsuleSha256)fail('prior_result_binding');
  for(const key of ['freezeFingerprint','protocolFingerprint','datasetFingerprint','candidateFingerprint','qualityPolicySha256']){
    const expected=key==='freezeFingerprint'?freeze.fingerprint:freeze[key];
    if(report[key]!==expected||registry[key]!==expected)fail('prior_result_binding');
  }
  if(report.capsuleSha256!==freeze.capsuleSha256||started.startedAt<freeze.registeredAt||started.startedAt>=intent.createdAt)fail('prior_clock');
  if(intent.events.some(e=>protocol.request.events.some(p=>p.leagueId===e.leagueId)))fail('prior_event_reuse');
  if(protocol.qualityPolicySha256!==intent.qualityPolicySha256||intent.qualityPolicySha256!==proposal.qualityPolicySha256)fail('quality_policy_changed');
  return {protocolSha256:refs.protocol.sha256,protocolFingerprint:protocol.fingerprint,freezeSha256:refs.freeze.sha256,
    startedSha256:refs.started.sha256,reportSha256:refs.report.sha256,reportFingerprint:report.fingerprint,
    registrySha256:refs.registry.sha256,firstScoringAt:started.startedAt,qualityDecision:'failed',preserved:true};
}

export function registerRetestProtocol(context,registeredAt){
  clock(registeredAt);
  const request=parse(V1RetestRequestSchema,context.request,'request_invalid');
  const proposal=parse(V1RetestProposalSchema,context.proposal,'proposal_invalid');
  const intent=parse(V1RetestIntentSchema,context.intent,'intent_invalid');
  const catalogue=parse(V1ReleaseCatalogueCaptureSchema,context.catalogue,'catalogue_invalid');
  const files=parse(V1RetestFileExposureSchema,context.fileExposure,'exposure_invalid');
  const database=parse(V1RetestDatabaseExposureSchema,context.databaseExposure,'database_exposure_invalid');
  const access=parse(V1RetestAccessReviewSchema,context.accessReview,'access_review_invalid');
  const refs=context.refs;
  const bindings=[[request.proposalSha256,refs.proposal.sha256],[proposal.intent.sha256,refs.intent.sha256],
    [proposal.catalogue.sha256,refs.catalogue.sha256],[proposal.exposure.fileManifest.sha256,refs.fileExposure.sha256],
    [proposal.exposure.databaseSnapshot.sha256,refs.databaseExposure.sha256],[proposal.sourceCapture.sha256,refs.captureIndex.sha256],
    [proposal.metadataReview.sha256,refs.metadataReview.sha256],[access.proposalSha256,refs.proposal.sha256]];
  if(bindings.some(([a,b])=>a!==b))fail('source_binding');
  if(proposal.exposure.fileCount!==files.files.length||proposal.exposure.capturedAt!==files.capturedAt)fail('exposure_binding');
  if(intent.createdAt>=files.capturedAt||intent.createdAt>=database.capturedAt||proposal.checkedAt<files.capturedAt||
    proposal.checkedAt<database.capturedAt||access.checkedAt<proposal.checkedAt||access.checkedAt>registeredAt||
    intent.eventCutoffAt>=intent.createdAt||catalogue.source.fetchedAt>intent.createdAt||
    Date.parse(intent.createdAt)-Date.parse(catalogue.source.fetchedAt)>86400000)fail('evidence_clock');
  // Archived historical catalogue is pinned at the pre-discovery intent; it need not be refetched on replay.
  if(sha(catalogue.rawBody)!==catalogue.source.payloadSha256)fail('catalogue_hash');
  let entries;try{entries=V1ReleaseCatalogueRowsSchema.parse(JSON.parse(catalogue.rawBody));}catch{fail('catalogue_invalid');}
  for(const e of intent.events){const hits=entries.filter(x=>x.leagueid===e.leagueId);
    if(hits.length!==1||hits[0].name!==e.name||!['professional','premium'].includes(hits[0].tier))fail('event_binding');}
  if(proposal.proposal.eventCount!==intent.events.length)fail('scope_binding');
  for(const key of ['historyWarmupFromAt','historyRequestBeforeAt','historyWindowDays','historyMaxMapsPerAccount','maxMaps',
    'maxDetailAttemptsPerMap','maxRequestsPerRun','collectionDeadline'])if(request.collection[key]!==proposal.proposal[key])fail('collection_changed');
  if(request.collection.historyWarmupFromAt!==intent.warmupFromAt||request.collection.historyRequestBeforeAt!==intent.events.map(e=>e.fromAt).sort()[0]||
    request.collection.maxMaps!==intent.limits.maxUniqueMaps||request.collection.maxDetailAttemptsPerMap!==intent.limits.maxDetailAttemptsPerMap||
    request.collection.collectionDeadline!==intent.limits.proposedCollectionDeadline)fail('collection_changed');
  if(registeredAt>=request.collection.collectionDeadline)fail('registration_deadline');
  const previous=previousFailure(context,intent,proposal);
  const exposure={capturedAt:[files.capturedAt,database.capturedAt].sort().at(-1),
    blockedMatchIds:[...new Set([...files.potentialMapIds,...database.maps.map(m=>m.matchId)])].sort(numeric),
    opendotaSeriesIds:[...new Set([...files.opendotaSeriesIds,...database.maps.filter(m=>m.provider==='opendota'&&m.providerSeriesId).map(m=>m.providerSeriesId)])].sort(numeric)};
  const review=retestMetadata(intent,exposure,context.captures,proposal.checkedAt);
  // The proposal ledger was built privately before this contract; compare all rows, not only totals.
  const recorded=context.metadataReview;
  if(recorded.intentSha256!==refs.intent.sha256||!same(recorded.summary,review.summary)||!same(proposal.summary,review.summary)||
    !same([...recorded.ledger].sort((a,b)=>numeric(a.matchId,b.matchId)),review.ledger))fail('proposal_ledger_changed');
  if(recorded.newModelEvaluationPerformed!==false||recorded.detailEligibilityVerified!==false)fail('proposal_already_evaluated');
  const policy=context.previous.protocol.qualityPolicy;
  const body={schemaVersion:2,format:'v1-historical-retest-protocol-v2',registeredAt,
    request:{...request,evaluationBasis:'conditional_retrospective_unexposed_series',events:intent.events,
      warmupFromAt:intent.warmupFromAt,eventCutoffAt:intent.eventCutoffAt,maxInventoryMaps:5000},
    inputFingerprints:{proposal:hash(proposal),intent:hash(intent),catalogue:hash(catalogue),exposure:hash(exposure),
      accessReview:hash(access),metadata:hash(review),previous:hash(previous)},
    evidence:refs,selectionCommittedAt:intent.createdAt,previousAttempt:previous,
    qualityPolicy:policy,qualityPolicySha256:hash(policy),collection:request.collection,
    exposure:{capturedAt:exposure.capturedAt,blockedMatchIds:exposure.blockedMatchIds.length,opendotaSeriesIds:exposure.opendotaSeriesIds.length,
      fileCount:files.files.length,scope:'bounded_local_not_global_blindness_proof',additionalAccessReviewAt:access.checkedAt},
    metadata:{summary:review.summary,denominator:review.denominator,ledgerFingerprint:hash(review.ledger),sourceCount:review.sources.length,
      sources:review.sources,providerCompleteness:'unknown',eligibilityVerified:false,denominatorRefinement:'verified_series_binding_only_keep_every_discovered_id'},
    independence:{basis:'intent_before_metadata_and_protocol_before_details_or_model_scoring',
      wholeEventExclusions:intent.wholeEventExclusions,disclosures:intent.disclosures,
      priorFailUse:'planning_only_no_tuning',earlierCalendarCohort:true,prospectiveAccuracyClaim:false,
      familywise95Claim:false,bestAttemptSelection:false,partialEvaluation:false},
    syntheticOnly:context.previous.protocol.syntheticOnly||proposal.syntheticOnly===true,
    status:'retest_protocol_registered_not_collected',executableFreezeRegistered:false,registryCompatible:false,
    evaluation:null,teamAWinProbability:null,deployable:false};
  return stamp(body);
}

export function verifyRetestProtocol(saved,context){
  if(saved?.format!=='v1-historical-retest-protocol-v2'||saved.schemaVersion!==2)fail('protocol_format');
  const rebuilt=registerRetestProtocol(context,saved.registeredAt);
  if(!same(saved,rebuilt))fail('protocol_replay');return rebuilt;
}

export async function readRetestInputs(path,expectedSha){
  const refs=parse(V1RetestFilesSchema,(await bounded(path,65536,expectedSha)).data,'config_invalid');
  const context={refs};
  for(const key of ['request','proposal','intent','catalogue','fileExposure','databaseExposure','captureIndex','metadataReview','accessReview']){
    context[key]=(await bounded(refs[key].path,key==='fileExposure'||key==='databaseExposure'?33554432:16777216,refs[key].sha256)).data;
  }
  const index=parse(V1RetestCaptureIndexSchema,context.captureIndex,'capture_index_invalid');
  context.captures=[];for(const ref of index.captures)context.captures.push((await bounded(ref.path,16777216,ref.sha256)).data);
  if(index.completedAt>context.proposal.checkedAt)fail('capture_index_clock');
  const access=parse(V1RetestAccessReviewSchema,context.accessReview,'access_review_invalid');
  await bounded(access.evidence.path,33554432,access.evidence.sha256);
  context.previous={inputs:await readHistoricalInputs(refs.previous.inputs.path,refs.previous.inputs.sha256)};
  for(const key of ['protocol','freeze','started','report','registry'])context.previous[key]=
    (await bounded(refs.previous[key].path,key==='report'?134217728:16777216,refs.previous[key].sha256)).data;
  return context;
}
export {bounded,save,sha};
