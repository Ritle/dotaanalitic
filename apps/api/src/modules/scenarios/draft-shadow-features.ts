/** Runtime port of the frozen shadow v2 adapter; parity is tested against its offline implementation. */
import assert from 'node:assert/strict';
import {z} from 'zod';
// Explicit built-package boundary keeps the active V1 lockfile/manifests unchanged.
import {createV1FeatureBuilder,V1_FEATURE_POLICY} from '../../../../../packages/prediction/dist/index.js';
import {V1FeatureMapSchema} from '@dota/contracts';
import type {DraftCaptureSavedSchema} from './draft-capture-contract.js';
import type {DraftHistorySaved} from './draft-history-contract.js';
import {captureDraftPlayers} from './draft-capture-players.js';
import {captureMicros} from './draft-target-resolution.js';
import {createPlayerHeroFeatureBuilder,HistorySchema} from './draft-shadow-hero.js';
type DraftCaptureSaved=z.infer<typeof DraftCaptureSavedSchema>;
const us=(s:string)=>String(BigInt(Date.parse(s))*1000n),numeric=(a:string,b:string)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const unique=(xs:unknown[],reason:string)=>assert.equal(new Set(xs).size,xs.length,reason);
const sorted=(xs:string[])=>[...new Set(xs)].sort();
const unavailable=(reasons:string[],extra:Record<string,unknown>={})=>({status:'unavailable' as const,reasons:sorted(reasons),inputs:null,encoded:null,...extra});
export function buildShadowFeatures(capture:DraftCaptureSaved,observation:DraftHistorySaved|null,syntheticOnly:boolean){
  const targetId=null; // No sentinel and no late-binding-dependent feature rebuild.
  if(!observation)return unavailable(['PRE_CUTOFF_HISTORY_OBSERVATION_MISSING']);
  const c=capture,e=observation.evidence,h=e.history,cutoff=captureMicros(c.snapshot.decisionCutoffAt),read=captureMicros(e.readAt);
  const until=cutoff.toString(),frozenAt=captureMicros(c.recordedAt).toString();
  const identityLedger=h.identities.map(i=>{
    const reasons:string[]=[];
    if(BigInt(us(i.fetchedAt))>=read)reasons.push('IDENTITY_FETCH_NOT_BEFORE_HISTORY_READ');
    if(i.knownAt!==null&&BigInt(us(i.knownAt))>=read)reasons.push('IDENTITY_KNOWN_NOT_BEFORE_HISTORY_READ');
    if(i.eventAt!==null&&BigInt(us(i.eventAt))>=read)reasons.push('IDENTITY_EVENT_NOT_BEFORE_HISTORY_READ');
    return {observationId:i.observationId,included:reasons.length===0,reasons};
  });
  unique(identityLedger.map(i=>i.observationId),'duplicate_identity_observation');
  const acceptedIdentity=new Set(identityLedger.filter(i=>i.included).map(i=>i.observationId));
  const identities=h.identities.filter(i=>acceptedIdentity.has(i.observationId));
  const selection=captureDraftPlayers(c.snapshot.scenario,identities),reasons=[...e.reasons];
  const binding=(p:DraftCaptureSaved["snapshot"]["players"][number])=>({teamSlot:p.teamSlot,rolePos:p.rolePos,playerId:p.playerId,accountId:p.accountId,heroId:p.heroId,identityStatus:p.identityStatus});
  const normalize=(ps:DraftCaptureSaved["snapshot"]["players"])=>ps.map(binding).sort((a,b)=>a.teamSlot.localeCompare(b.teamSlot)||a.rolePos-b.rolePos);
  if(JSON.stringify(normalize(selection))!==JSON.stringify(normalize(c.snapshot.players)))reasons.push('SELECTION_IDENTITY_NOT_AS_OBSERVED');
  if(selection.some(p=>p.accountId===null||p.heroId===null||p.identityStatus!=='verified')||new Set(selection.map(p=>p.accountId)).size!==10||
    new Set(selection.map(p=>p.playerId)).size!==10||new Set(selection.map(p=>p.heroId)).size!==10)reasons.push('TEN_VERIFIED_PLAYERS_AND_DISTINCT_HEROES_REQUIRED');
  const selectedAccounts=new Set(selection.map(p=>p.accountId));
  if(h.status!=='captured')reasons.push('HISTORY_PROJECTION_UNAVAILABLE');
  const receipts=new Map(h.receipts.map(r=>[r.id,r])),outcomes=new Map(e.outcomes.map(o=>[o.matchId,o]));
  unique(h.receipts.map(r=>r.id),'duplicate_receipt');unique(h.series.map(s=>s.id),'duplicate_series');
  const series=new Set(h.series.map(s=>s.id)),mapIds=new Set(h.maps.map(m=>m.id)),players=new Map<string,DraftHistorySaved["evidence"]["history"]["players"]>();
  for(const p of h.players){assert(mapIds.has(p.match_id),'foreign_history_player');const rows=players.get(p.match_id)??[];rows.push(p);players.set(p.match_id,rows);}
  for(const r of receipts.values())assert(mapIds.has(r.canonical_match_id),'foreign_history_receipt');
  const projected=new Map<string,{elo:z.infer<typeof V1FeatureMapSchema>;hero:z.infer<typeof HistorySchema>["maps"][number]}>();
  const mapLedger=h.maps.map(m=>{
    const failures:string[]=[],o=outcomes.get(m.id),ps=(players.get(m.id)??[]).slice().sort((a,b)=>a.player_slot-b.player_slot);
    const seriesKey=m.series_id&&series.has(m.series_id)?'canonical:'+m.series_id:null;
    // Exclude any possible same-ten target, even after side/hero swaps, before reading its outcome.
    if(ps.length===10&&new Set(ps.map(p=>p.source_account_id)).size===10&&ps.every(p=>selectedAccounts.has(p.source_account_id)))
      return {matchId:m.id,seriesKey,included:false,reasons:['SELECTED_TEN_ENCOUNTER_EXCLUDED']};
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
      if(!failures.length&&r){
        const members=(rows:typeof ps)=>rows.map(p=>({playerId:p.player_id!,accountId:p.source_account_id!}));
        const elo={matchId:m.id,seriesKey:seriesKey!,startedAtUs:m.started_at_us,completedAtUs:us(o.completedAt),isPro:true as const,
          teamA:members(ps.filter(p=>p.side==='radiant')),teamB:members(ps.filter(p=>p.side==='dire')),teamAWon:o.teamAWon,
          outcomeReceiptId:r.id,payloadSha256:r.payload_sha256,fetchedAtUs:r.fetched_at_us,
          labelVerifiedAtUs:captureMicros(e.observedAt).toString(),factClocks:[]};
        if(!V1FeatureMapSchema.safeParse(elo).success)failures.push('INVALID_ELO_HISTORY_MAP');
        else projected.set(m.id,{elo,hero:{matchId:m.id,startedAtUs:m.started_at_us,completedAtUs:us(o.completedAt),
          fetchedAtUs:r.fetched_at_us,knownAtUs:r.known_at_us,isPro:true,receiptSha256:r.payload_sha256,canonicalPatchId:m.patch_id,
          players:ps.map(p=>({playerId:p.player_id!,accountId:p.source_account_id!,heroId:p.hero_id}))}});
      }
    }
    return {matchId:m.id,seriesKey,included:!failures.length,reasons:sorted(failures)};
  }).sort((a,b)=>numeric(a.matchId,b.matchId));
  const badSeries=new Set(mapLedger.filter(m=>!m.included&&m.seriesKey!==null).map(m=>m.seriesKey));
  for(const m of mapLedger)if(badSeries.has(m.seriesKey)){m.included=false;m.reasons=sorted([...m.reasons,'SERIES_HAS_INELIGIBLE_HISTORY']);}
  const details={mapLedger,identityLedger,coverage:{nRaw:null,excludedMaps:mapLedger.filter(m=>!m.included).length},
    historyReadAt:e.readAt,observationRecordedAt:observation.recordedAt,rawSnapshotRequired:false};
  if(reasons.length)return unavailable(reasons,details);
  const maps=mapLedger.filter(m=>m.included).map(m=>projected.get(m.matchId)!.elo);
  const side=(slot:'A'|'B')=>selection.filter(p=>p.teamSlot===slot).map(p=>({playerId:p.playerId,accountId:p.accountId!,heroId:p.heroId!}));
  const strip=(xs:ReturnType<typeof side>)=>xs.map(({playerId,accountId})=>({playerId,accountId}));
  const elo=createV1FeatureBuilder({schemaVersion:1,profile:'player-mean-elo-completed-strict-v1',sourceFingerprint:observation.sha256,
    identityRevision:captureMicros(observation.recordedAt).toString(),snapshotAtUs:frozenAt,warmupFromAtUs:'0',syntheticOnly,identities,maps})({
    schemaVersion:1,targetMatchId:targetId,cutoffAtUs:until,teamA:strip(side('A')),teamB:strip(side('B')),
    lineup:{basis:'manual',source:'sql060:'+observation.id,selectedAtUs:captureMicros(c.snapshot.scenarioRecordedAt).toString(),revision:String(c.snapshot.revision)}});
  const eloExcluded=new Map(elo.history.excludedMaps.map(m=>[m.matchId,m.reasons]));
  for(const m of mapLedger)if(eloExcluded.has(m.matchId)){m.included=false;m.reasons=sorted([...m.reasons,...eloExcluded.get(m.matchId)!]);}
  if(elo.status!=='ready')reasons.push(...elo.reasons);
  const used=new Set(elo.history.usedMatchIds),heroMaps=mapLedger.filter(m=>m.included&&used.has(m.matchId)).map(m=>projected.get(m.matchId)!.hero);
  const hero=createPlayerHeroFeatureBuilder({format:'verified-player-hero-history-v1',syntheticOnly,sourceSha256:observation.sha256,
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
