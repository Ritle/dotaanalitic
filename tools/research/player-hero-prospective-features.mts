/** Offline adapter only. Declared evidence is not authenticated collection. */
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {V1FeatureHistorySchema} from '../../packages/contracts/dist/index.js';
import {createV1FeatureBuilder,V1_FEATURE_POLICY} from '../../packages/prediction/dist/index.js';
import {createProspectiveCapture,captureDigest} from './player-hero-prospective-capture.mjs';

const Sha=z.string().regex(/^[a-f0-9]{64}$/);
const Time=z.string().regex(/^(0|[1-9]\d{0,17})$/);
const Observation=z.object({sourceSha256:Sha,factSha256:Sha,sourceKnownAtUs:Time.nullable(),
  fetchedAtUs:Time,observedAtUs:Time,recordedAtUs:Time}).strict();
export const ProspectiveFeatureInputSchema=z.object({
  format:z.literal('player-hero-prospective-features-input-v1'),capture:z.unknown(),
  history:V1FeatureHistorySchema,
  outcomeObservations:z.array(Observation.extend({matchId:z.string().regex(/^[1-9]\d*$/),
    basis:z.literal('verified_professional_map_outcome')}).strict()).max(5000),
  identityObservations:z.array(Observation.extend({observationId:z.string().min(1).max(512)}).strict()).max(100000),
}).strict();
const us=(time:string)=>String(BigInt(Date.parse(time))*1000n);
const compare=(a:string,b:string)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
const key=(p:{playerId:string;accountId:string})=>p.playerId+':'+p.accountId;
const members=(players:{playerId:string;accountId:string}[])=>players.map(key).sort();
function unique(values:string[],code:string){if(new Set(values).size!==values.length)throw Error(code);}
function frozen<T>(value:T):T {
  if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}
  return value;
}
function clockReasons(o:z.infer<typeof Observation>,cutoff:bigint){
  const reasons:string[]=[];
  for(const name of ['sourceKnownAtUs','fetchedAtUs','observedAtUs','recordedAtUs'] as const)
    if(o[name]!==null&&BigInt(o[name])>=cutoff)reasons.push('EVIDENCE_NOT_BEFORE_CUTOFF');
  if(BigInt(o.fetchedAtUs)>BigInt(o.observedAtUs)||BigInt(o.observedAtUs)>BigInt(o.recordedAtUs)||
    (o.sourceKnownAtUs!==null&&BigInt(o.sourceKnownAtUs)>BigInt(o.observedAtUs)))reasons.push('INVALID_EVIDENCE_ORDER');
  return reasons;
}

/** Replays the immutable capture; no target label or caller-supplied Elo is accepted. */
export function buildProspectivePlayerHeroFeatures(raw:unknown){
  const input=ProspectiveFeatureInputSchema.parse(raw);
  const saved=z.object({input:z.unknown(),fingerprint:Sha}).passthrough().parse(input.capture);
  const capture=createProspectiveCapture(saved.input);
  if(captureDigest(capture)!==captureDigest(saved))throw Error('capture_replay_mismatch');
  const history=input.history,scenario=capture.input.scenario,cutoff=BigInt(capture.decisionCutoffAtUs);
  if(history.syntheticOnly!==capture.syntheticOnly)throw Error('synthetic_provenance_mismatch');
  if(history.warmupFromAtUs!==capture.input.history.fromAtUs||history.snapshotAtUs!==capture.input.history.snapshotAtUs)
    throw Error('history_window_mismatch');
  unique(history.maps.map(m=>m.matchId),'duplicate_outcome_map');
  unique(history.identities.map(i=>i.observationId),'duplicate_identity');
  unique(input.outcomeObservations.map(o=>o.matchId),'duplicate_outcome_observation');
  unique(input.identityObservations.map(o=>o.observationId),'duplicate_identity_observation');
  const original=new Map(capture.input.history.maps.map(m=>[m.matchId,m]));
  const available=new Set(capture.availableHistory.maps.map(m=>m.matchId));
  const outcomes=new Map(input.outcomeObservations.map(o=>[o.matchId,o]));
  const identities=new Map(input.identityObservations.map(o=>[o.observationId,o]));
  if(input.outcomeObservations.some(o=>!history.maps.some(m=>m.matchId===o.matchId)))throw Error('foreign_outcome_observation');
  if(input.identityObservations.some(o=>!history.identities.some(i=>i.observationId===o.observationId)))throw Error('foreign_identity_observation');
  const reasons:string[]=[];
  if(capture.status!=='validated_offline_contract')reasons.push('CAPTURE_UNAVAILABLE');
  if([...original.keys()].some(id=>id!==scenario.targetMatchId&&!history.maps.some(m=>m.matchId===id)))
    reasons.push('OUTCOME_HISTORY_INCOMPLETE');
  const identityLedger=history.identities.map(identity=>{
    const o=identities.get(identity.observationId),failures:string[]=[];
    if(!o)failures.push('IDENTITY_OBSERVATION_MISSING');
    else {
      if(o.factSha256!==captureDigest(identity)||o.fetchedAtUs!==us(identity.fetchedAt)||
        o.sourceKnownAtUs!==(identity.knownAt===null?null:us(identity.knownAt)))throw Error('identity_evidence_binding_mismatch');
      failures.push(...clockReasons(o,cutoff));
      if(identity.eventAt!==null&&BigInt(us(identity.eventAt))>=cutoff)failures.push('IDENTITY_EVENT_NOT_BEFORE_CUTOFF');
    }
    return {observationId:identity.observationId,included:!failures.length,reasons:[...new Set(failures)]};
  });
  const mapLedger=history.maps.map(map=>{
    if(map.matchId===scenario.targetMatchId)throw Error('target_outcome_forbidden');
    const prior=original.get(map.matchId);if(!prior)throw Error('foreign_outcome_map');
    if(map.startedAtUs!==prior.startedAtUs||map.completedAtUs!==prior.completedAtUs||
      captureDigest(members([...map.teamA,...map.teamB]))!==captureDigest(members(prior.players)))throw Error('history_map_binding_mismatch');
    const failures:string[]=available.has(map.matchId)?[]:['CAPTURE_HISTORY_EXCLUDED'];
    const o=outcomes.get(map.matchId);
    if(!o)failures.push('OUTCOME_OBSERVATION_MISSING');
    else {
      if(o.factSha256!==captureDigest(map)||o.sourceSha256!==map.payloadSha256||o.fetchedAtUs!==map.fetchedAtUs)
        throw Error('outcome_evidence_binding_mismatch');
      failures.push(...clockReasons(o,cutoff));
      if(BigInt(o.observedAtUs)<BigInt(map.labelVerifiedAtUs))failures.push('OBSERVED_BEFORE_OUTCOME_VERIFICATION');
    }
    if(BigInt(map.labelVerifiedAtUs)>=cutoff)failures.push('OUTCOME_VERIFIED_NOT_BEFORE_CUTOFF');
    if(map.factClocks.some(f=>[f.eventAtUs,f.knownAtUs,f.fetchedAtUs,f.recordedAtUs]
      .some(t=>t!==null&&BigInt(t)>=cutoff)))failures.push('HISTORY_FACT_NOT_BEFORE_CUTOFF');
    return {matchId:map.matchId,seriesKey:map.seriesKey,included:!failures.length,reasons:[...new Set(failures)]};
  });
  // Preserve whole known series closure before the unchanged Elo identity/warmup gate.
  const badSeries=new Set(mapLedger.filter(m=>!m.included).map(m=>m.seriesKey));
  for(const row of mapLedger)if(badSeries.has(row.seriesKey)){
    row.included=false;row.reasons.push('SERIES_HAS_UNAVAILABLE_OUTCOME');
  }
  const acceptedMaps=new Set(mapLedger.filter(m=>m.included).map(m=>m.matchId));
  const acceptedIdentities=new Set(identityLedger.filter(i=>i.included).map(i=>i.observationId));
  const filteredHistory={...history,maps:history.maps.filter(m=>acceptedMaps.has(m.matchId)),
    identities:history.identities.filter(i=>acceptedIdentities.has(i.observationId))};
  const strip=(players:typeof scenario.teamA)=>players.map(({playerId,accountId})=>({playerId,accountId}));
  const elo=createV1FeatureBuilder(filteredHistory)({schemaVersion:1,targetMatchId:scenario.targetMatchId,
    cutoffAtUs:scenario.cutoffAtUs,teamA:strip(scenario.teamA),teamB:strip(scenario.teamB),
    lineup:{basis:'manual',source:'prospective-capture:'+capture.fingerprint,selectedAtUs:scenario.selectedAtUs,revision:capture.scenarioRevision}});
  if(elo.status!=='ready')reasons.push(...elo.reasons);
  const uniqueReasons=[...new Set(reasons)].sort();
  const inputs=!uniqueReasons.length&&elo.features!==null&&capture.observedHeroPracticeLog90Delta!==null
    ?{eloLogit:Math.log(10)*elo.features.eloDifference/V1_FEATURE_POLICY.scale,
      observedHeroPracticeLog90Delta:capture.observedHeroPracticeLog90Delta}:null;
  const body={format:'player-hero-prospective-features-v1',status:inputs?'ready_offline_features':'unavailable',
    syntheticOnly:capture.syntheticOnly,inputSha256:captureDigest(input),captureFingerprint:capture.fingerprint,
    decisionCutoffAtUs:capture.decisionCutoffAtUs,reasons:uniqueReasons,inputs,
    encoded:inputs?{H1:[inputs.eloLogit],H2:[inputs.eloLogit,inputs.observedHeroPracticeLog90Delta]}:null,
    mapLedger:mapLedger.sort((a,b)=>compare(a.matchId,b.matchId)),identityLedger,eloSnapshot:elo,
    assumptions:['OFFLINE_EVIDENCE_ASSERTIONS_NOT_AUTHENTICATED','REMOTE_HISTORY_AND_SERIES_COMPLETENESS_UNKNOWN',
      'FROZEN_ELO_CONDITIONAL_ASSUMPTIONS_RETAINED','HERO_HISTORY_AND_VERIFIED_OUTCOME_COUNTS_ARE_SEPARATE'],
    primaryEligible:false,registrationAllowed:false,collectionAllowed:false,trainingPerformed:false,
    scoringPerformed:false,releaseGatePassed:false,deployable:false,teamAWinProbability:null};
  return frozen({...body,fingerprint:captureDigest(body)});
}
