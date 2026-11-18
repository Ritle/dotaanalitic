/** SQL060 adapter: immutable owner selection, separately bound native target, no scoring. */
import assert from 'node:assert/strict';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {registrySha} from '../../packages/db/dist/index.js';
import {createV1FeatureBuilder,V1_FEATURE_POLICY} from '../../packages/prediction/dist/index.js';
import {V1FeatureMapSchema} from '../../packages/contracts/dist/index.js';
import {DraftHistorySavedSchema} from '../../apps/api/dist/modules/scenarios/draft-history-contract.js';
import {CaptureTimeSchema} from '../../apps/api/dist/modules/scenarios/draft-capture-contract.js';
import {captureDraftPlayers} from '../../apps/api/dist/modules/scenarios/draft-capture-players.js';
import {captureMicros} from '../../apps/api/dist/modules/scenarios/draft-target-resolution.js';
import {createPlayerHeroFeatureBuilder} from '../../.tools/s304-prospective-features-runtime/player-hero-feature.mjs';
import {auditNativeExport,NativeExportSourceSchema} from './draft-native-export-core.mjs';
const Hash=z.string().regex(/^[a-f0-9]{64}$/),Time=CaptureTimeSchema;
export const ObservationFeatureSourceSchema=z.object({format:z.literal('draft-observation-feature-source-v1'),native:NativeExportSourceSchema,
  observations:z.array(z.object({id:z.uuid(),ownerId:z.uuid(),scenarioId:z.uuid(),revision:z.number().int().positive(),
    readAt:Time,observedAt:Time,recordedAt:Time,evidenceText:z.string().max(33554432),evidenceSha256:Hash}).strict()).max(100),
  links:z.array(z.object({captureId:z.uuid(),observationId:z.uuid(),recordedAt:Time}).strict()).max(100)
}).strict();
const us=s=>String(BigInt(Date.parse(s))*1000n),numeric=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const unique=(xs,reason)=>assert.equal(new Set(xs).size,xs.length,reason);
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const sorted=xs=>[...new Set(xs)].sort();
const unavailable=(reasons,extra={})=>({status:'unavailable',reasons:sorted(reasons),inputs:null,encoded:null,...extra});

function build(capture,observation,targetId,syntheticOnly){
  if(!observation)return unavailable(['PRE_CUTOFF_HISTORY_OBSERVATION_MISSING']);
  const c=capture,e=observation.evidence,h=e.history,cutoff=captureMicros(c.snapshot.decisionCutoffAt),read=captureMicros(e.readAt);
  const until=cutoff.toString(),frozenAt=captureMicros(c.recordedAt).toString();
  const identityLedger=h.identities.map(i=>{
    const reasons=[];
    if(BigInt(us(i.fetchedAt))>=read)reasons.push('IDENTITY_FETCH_NOT_BEFORE_HISTORY_READ');
    if(i.knownAt!==null&&BigInt(us(i.knownAt))>=read)reasons.push('IDENTITY_KNOWN_NOT_BEFORE_HISTORY_READ');
    if(i.eventAt!==null&&BigInt(us(i.eventAt))>=read)reasons.push('IDENTITY_EVENT_NOT_BEFORE_HISTORY_READ');
    return {observationId:i.observationId,included:reasons.length===0,reasons};
  });
  unique(identityLedger.map(i=>i.observationId),'duplicate_identity_observation');
  const acceptedIdentity=new Set(identityLedger.filter(i=>i.included).map(i=>i.observationId));
  const identities=h.identities.filter(i=>acceptedIdentity.has(i.observationId));
  const selection=captureDraftPlayers(c.snapshot.scenario,identities),reasons=[...e.reasons];
  const binding=p=>({teamSlot:p.teamSlot,rolePos:p.rolePos,playerId:p.playerId,accountId:p.accountId,heroId:p.heroId,identityStatus:p.identityStatus});
  const normalize=ps=>ps.map(binding).sort((a,b)=>a.teamSlot.localeCompare(b.teamSlot)||a.rolePos-b.rolePos);
  if(JSON.stringify(normalize(selection))!==JSON.stringify(normalize(c.snapshot.players)))reasons.push('SELECTION_IDENTITY_NOT_AS_OBSERVED');
  if(selection.some(p=>p.accountId===null||p.heroId===null||p.identityStatus!=='verified')||new Set(selection.map(p=>p.accountId)).size!==10||
    new Set(selection.map(p=>p.playerId)).size!==10||new Set(selection.map(p=>p.heroId)).size!==10)reasons.push('TEN_VERIFIED_PLAYERS_AND_DISTINCT_HEROES_REQUIRED');
  if(targetId===null)reasons.push('NATIVE_TARGET_UNRESOLVED');
  if(h.status!=='captured')reasons.push('HISTORY_PROJECTION_UNAVAILABLE');
  const receipts=new Map(h.receipts.map(r=>[r.id,r])),outcomes=new Map(e.outcomes.map(o=>[o.matchId,o]));
  unique(h.receipts.map(r=>r.id),'duplicate_receipt');unique(h.series.map(s=>s.id),'duplicate_series');
  const series=new Set(h.series.map(s=>s.id)),mapIds=new Set(h.maps.map(m=>m.id)),players=new Map();
  for(const p of h.players){assert(mapIds.has(p.match_id),'foreign_history_player');const rows=players.get(p.match_id)??[];rows.push(p);players.set(p.match_id,rows);}
  for(const r of receipts.values())assert(mapIds.has(r.canonical_match_id),'foreign_history_receipt');
  const projected=new Map();
  const mapLedger=h.maps.map(m=>{
    const failures=[],o=outcomes.get(m.id),ps=(players.get(m.id)??[]).slice().sort((a,b)=>a.player_slot-b.player_slot);
    const seriesKey=m.series_id&&series.has(m.series_id)?'canonical:'+m.series_id:null;
    if(m.id===targetId)return {matchId:m.id,seriesKey,included:false,reasons:['TARGET_MAP_EXCLUDED']};
    if(!seriesKey)failures.push('HISTORY_SERIES_UNRESOLVED');
    if(m.ingest_state==='conflict')failures.push('MAP_CONFLICT');
    if(!o||o.status!=='verified')failures.push(...(o?.reasons??['VERIFIED_OUTCOME_MISSING']));
    const slots=[0,1,2,3,4,128,129,130,131,132];
    if(ps.length!==10||ps.some((p,i)=>p.player_slot!==slots[i]||p.side!==(p.player_slot<128?'radiant':'dire')||p.player_id===null||p.source_account_id===null)||
      new Set(ps.map(p=>p.player_id)).size!==10||new Set(ps.map(p=>p.source_account_id)).size!==10)failures.push('INVALID_HISTORY_FIVES');
    const heroes=ps.flatMap(p=>p.hero_id===null?[]:[p.hero_id]);
    if(new Set(heroes).size!==heroes.length||heroes.some(id=>id<=0))failures.push('INVALID_HISTORY_HEROES');
    if(o?.status==='verified'){
      const r=receipts.get(o.outcomeReceiptId),end=BigInt(us(o.completedAt)),start=BigInt(m.started_at_us);
      if(start>=cutoff||end>=cutoff||end<=start)failures.push('MAP_NOT_COMPLETED_BEFORE_CUTOFF');
      if(!r||!['accepted','partial'].includes(r.status)||BigInt(r.fetched_at_us)<end||BigInt(r.fetched_at_us)>=read||
        BigInt(r.fetched_at_us)/1000n!==BigInt(Date.parse(o.sourceEvidence.receiptFetchedAt)))failures.push('OUTCOME_RECEIPT_CLOCK_OR_STATUS');
      if(r?.known_at_us!==null&&r?.known_at_us!==undefined&&BigInt(r.known_at_us)>captureMicros(e.observedAt))failures.push('SOURCE_KNOWN_AFTER_OBSERVATION');
      if(r?.event_at_us!==null&&r?.event_at_us!==undefined&&BigInt(r.event_at_us)>=cutoff)failures.push('RECEIPT_EVENT_NOT_BEFORE_CUTOFF');
      if(!failures.length){
        const members=rows=>rows.map(p=>({playerId:p.player_id,accountId:p.source_account_id}));
        const elo={matchId:m.id,seriesKey,startedAtUs:m.started_at_us,completedAtUs:us(o.completedAt),isPro:true,
          teamA:members(ps.filter(p=>p.side==='radiant')),teamB:members(ps.filter(p=>p.side==='dire')),teamAWon:o.teamAWon,
          outcomeReceiptId:r.id,payloadSha256:r.payload_sha256,fetchedAtUs:r.fetched_at_us,
          labelVerifiedAtUs:captureMicros(e.observedAt).toString(),factClocks:[]};
        if(!V1FeatureMapSchema.safeParse(elo).success)failures.push('INVALID_ELO_HISTORY_MAP');
        else projected.set(m.id,{elo,hero:{matchId:m.id,startedAtUs:m.started_at_us,completedAtUs:us(o.completedAt),
          fetchedAtUs:r.fetched_at_us,knownAtUs:r.known_at_us,isPro:true,receiptSha256:r.payload_sha256,canonicalPatchId:m.patch_id,
          players:ps.map(p=>({playerId:p.player_id,accountId:p.source_account_id,heroId:p.hero_id}))}});
      }
    }
    return {matchId:m.id,seriesKey,included:!failures.length,reasons:sorted(failures)};
  }).sort((a,b)=>numeric(a.matchId,b.matchId));
  const badSeries=new Set(mapLedger.filter(m=>!m.included&&!m.reasons.includes('TARGET_MAP_EXCLUDED')&&m.seriesKey!==null).map(m=>m.seriesKey));
  for(const m of mapLedger)if(m.matchId!==targetId&&badSeries.has(m.seriesKey)){m.included=false;m.reasons=sorted([...m.reasons,'SERIES_HAS_INELIGIBLE_HISTORY']);}
  const details={mapLedger,identityLedger,coverage:{nRaw:null,excludedMaps:mapLedger.filter(m=>!m.included).length},
    historyReadAt:e.readAt,observationRecordedAt:observation.recordedAt,rawSnapshotRequired:false};
  if(reasons.some(r=>r!=='NATIVE_TARGET_UNRESOLVED'))return unavailable(reasons,details);
  const maps=mapLedger.filter(m=>m.included).map(m=>projected.get(m.matchId).elo);
  const side=slot=>selection.filter(p=>p.teamSlot===slot).map(p=>({playerId:p.playerId,accountId:p.accountId,heroId:p.heroId}));
  const strip=xs=>xs.map(({playerId,accountId})=>({playerId,accountId}));
  const elo=createV1FeatureBuilder({schemaVersion:1,profile:'player-mean-elo-completed-strict-v1',sourceFingerprint:observation.sha256,
    identityRevision:captureMicros(observation.recordedAt).toString(),snapshotAtUs:frozenAt,warmupFromAtUs:'0',syntheticOnly,identities,maps})({
    schemaVersion:1,targetMatchId:targetId,cutoffAtUs:until,teamA:strip(side('A')),teamB:strip(side('B')),
    lineup:{basis:'manual',source:'sql060:'+observation.id,selectedAtUs:captureMicros(c.snapshot.scenarioRecordedAt).toString(),revision:String(c.snapshot.revision)}});
  const eloExcluded=new Map(elo.history.excludedMaps.map(m=>[m.matchId,m.reasons]));
  for(const m of mapLedger)if(eloExcluded.has(m.matchId)){m.included=false;m.reasons=sorted([...m.reasons,...eloExcluded.get(m.matchId)]);}
  if(elo.status!=='ready')reasons.push(...elo.reasons);
  const used=new Set(elo.history.usedMatchIds),heroMaps=mapLedger.filter(m=>m.included&&used.has(m.matchId)).map(m=>projected.get(m.matchId).hero);
  const hero=targetId===null?null:createPlayerHeroFeatureBuilder({format:'verified-player-hero-history-v1',syntheticOnly,sourceSha256:observation.sha256,
    fromAtUs:'0',toAtUs:until,snapshotAtUs:frozenAt,maps:heroMaps})({targetMatchId:targetId,cutoffAtUs:until,teamA:side('A'),teamB:side('B'),
    canonicalPatchId:null,heroBasis:'owner_selected',selectedAtUs:captureMicros(c.snapshot.scenarioRecordedAt).toString(),sourceSha256:observation.sha256});
  if(hero?.status==='unavailable')reasons.push(...hero.reasons);
  const inputs=!reasons.length&&elo.features!==null&&hero?.feature!==null&&hero!==null?
    {eloLogit:Math.log(10)*elo.features.eloDifference/V1_FEATURE_POLICY.scale,observedHeroPracticeLog90Delta:hero.feature}:null;
  return {status:inputs?'ready_offline_features':'unavailable',reasons:sorted(reasons),inputs,
    encoded:inputs?{H1:[inputs.eloLogit],H2:[inputs.eloLogit,inputs.observedHeroPracticeLog90Delta]}:null,
    ...details,coverage:{...elo.coverage,excludedMaps:mapLedger.filter(m=>!m.included).length},eloSnapshot:elo,heroSnapshot:hero,
    identityRevisionBasis:'observation_recorded_at_microseconds_not_global_identity_revision',fieldClockBasis:'SQL060_frozen_projection_not_SQL004_field_observations'};
}

export function auditObservationFeatures(raw){
  assert(Buffer.byteLength(JSON.stringify(raw))<=128*1024*1024,'source_size_limit');
  const source=ObservationFeatureSourceSchema.parse(raw),native=auditNativeExport(source.native),exported=captureMicros(source.native.exportedAt);
  unique(source.observations.map(o=>o.id),'duplicate_observation');unique(source.observations.map(o=>[o.ownerId,o.scenarioId,o.revision].join(':')),'duplicate_observation_revision');
  unique(source.links.map(l=>l.captureId),'duplicate_capture_link');unique(source.links.map(l=>l.observationId),'duplicate_observation_link');
  const observations=new Map(source.observations.map(row=>{
    assert.equal(registrySha(row.evidenceText),row.evidenceSha256,'observation_sha_mismatch');
    const saved=DraftHistorySavedSchema.parse({id:row.id,recordedAt:row.recordedAt,sha256:row.evidenceSha256,evidence:JSON.parse(row.evidenceText)});
    const e=saved.evidence;assert.equal(e.selection.scenarioId,row.scenarioId);assert.equal(e.selection.revision,row.revision);
    assert.equal(e.readAt,row.readAt);assert.equal(e.observedAt,row.observedAt);assert(captureMicros(row.recordedAt)<=exported,'observation_after_export');
    return [row.id,{row,saved}];
  }));
  const captures=new Map(source.native.captures.map(c=>[c.id,c])),links=new Map();
  for(const link of source.links){
    const c=captures.get(link.captureId),o=observations.get(link.observationId);assert(c&&o,'foreign_link');
    const snapshot=JSON.parse(c.snapshotText),s=o.saved.evidence.selection;
    assert(c.ownerId===o.row.ownerId&&c.scenarioId===s.scenarioId&&c.revision===s.revision,'foreign_observation_owner_or_revision');
    assert.equal(s.scenarioHash,snapshot.scenarioHash,'observation_selection_mismatch');
    assert.equal(registrySha(JSON.stringify(snapshot.scenario)),snapshot.scenarioHash,'scenario_hash_mismatch');
    assert(captureMicros(snapshot.scenarioRecordedAt)<=captureMicros(o.row.readAt)&&captureMicros(o.row.recordedAt)<captureMicros(snapshot.decisionCutoffAt),'observation_not_before_cutoff');
    assert(captureMicros(link.recordedAt)>=captureMicros(c.recordedAt)&&captureMicros(link.recordedAt)<=exported,'link_clock');links.set(c.id,o.saved);
  }
  const items=native.items.map(n=>{
    const row=captures.get(n.captureId),observation=links.get(n.captureId),capture={recordedAt:row.recordedAt,snapshot:JSON.parse(row.snapshotText)};
    return {captureId:row.id,observationId:observation?.id??null,actualMatchId:n.actualMatchId,duplicateOf:n.duplicateOf,diagnosticRepresentative:n.diagnosticRepresentative,
      attempts:n.attempts,features:build(capture,observation,n.actualMatchId,source.native.syntheticOnly),
      forecastStatus:'unavailable',eligibilityReasons:sorted(['ACTUAL_GAMEPLAY_START_UNVERIFIED','POST_DRAFT_MODEL_NOT_ACTIVATED',
        ...n.reasons.filter(r=>['CAPTURE_NOT_BEFORE_PROVIDER_START','DUPLICATE_ACTUAL_MAP','VERIFIED_NATIVE_BINDING_MISSING'].includes(r))]),
      primaryEligible:false,deployable:false,teamAWinProbability:null};
  });
  const linked=new Set(source.links.map(l=>l.observationId));
  const result={format:'draft-observation-features-v1',exportedAt:source.native.exportedAt,syntheticOnly:source.native.syntheticOnly,items,maps:native.maps,
    unlinkedObservationIds:source.observations.filter(o=>!linked.has(o.id)).map(o=>o.id).sort(),
    counts:{captures:items.length,observations:source.observations.length,links:source.links.length,distinctActualMaps:native.maps.length,
      featureReadyCaptures:items.filter(i=>i.features.inputs!==null).length,
      distinctFeatureReadyMaps:new Set(items.filter(i=>i.features.inputs!==null).map(i=>i.actualMatchId)).size,trainingExamples:0},
    assumptions:['DIAGNOSTIC_FEATURES_AT_OWNER_DECISION_CUTOFF_NOT_A_FORECAST','OFFLINE_REPLAY_DOES_NOT_AUTHENTICATE_DATABASE_OR_PRESTART_CAPTURE','REMOTE_HISTORY_AND_SERIES_COMPLETENESS_UNKNOWN',
      'FIELD_OBSERVATIONS_AND_RAW_PAYLOADS_NOT_IN_COMPACT_PROJECTION','OBSERVED_HERO_VOLUME_NOT_SKILL_OR_WIN_RATE'],
    primaryEligible:false,trainingPerformed:false,scoringPerformed:false,deployable:false,teamAWinProbability:null};
  return freeze({...result,fingerprint:registrySha(JSON.stringify(result))});
}
