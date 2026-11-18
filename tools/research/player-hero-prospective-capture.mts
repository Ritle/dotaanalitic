/** Offline availability contract. Evidence assertions are not authenticated live observations. */
import {createHash} from 'node:crypto';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {HistorySchema, ScenarioSchema, createPlayerHeroFeatureBuilder} from './player-hero-feature.mjs';

const Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n);
const Account=z.string().regex(/^[1-9]\d{0,9}$/).refine(v=>BigInt(v)<4294967295n);
const Time=z.string().regex(/^(0|[1-9]\d{0,18})$/).refine(v=>BigInt(v)<=8640000000000000000n);
const Sha=z.string().regex(/^[a-f0-9]{64}$/);
const Observation=z.object({sourceSha256:Sha,factSha256:Sha,sourceKnownAtUs:Time.nullable(),
  fetchedAtUs:Time,observedAtUs:Time,recordedAtUs:Time}).strict();
const SelectionObservation=Observation.extend({basis:z.enum(['owner_asserted_asof','verified_asof'])}).strict();
const IdentityObservation=Observation.extend({basis:z.literal('verified_account_link'),playerId:Id,accountId:Account}).strict();
const HistoryObservation=Observation.extend({basis:z.enum(['provider_known_at','local_receipt_verification']),matchId:Id}).strict();
const Scenario=ScenarioSchema.extend({targetMatchId:Id.nullable(),cutoffAtUs:Time,selectedAtUs:Time,
  heroBasis:z.literal('owner_selected')}).strict();

export const ProspectiveCaptureInputSchema=z.object({
  format:z.literal('player-hero-prospective-input-v1'),syntheticOnly:z.boolean(),
  decisionCutoffAtUs:Time,snapshotFrozenAtUs:Time,scenarioRevision:Id,
  scenario:Scenario,history:HistorySchema,
  lineupObservation:SelectionObservation.nullable(),draftObservation:SelectionObservation.nullable(),
  identityObservations:z.array(IdentityObservation).max(10),
  historyObservations:z.array(HistoryObservation).max(5000),
}).strict();
type CaptureInput=z.infer<typeof ProspectiveCaptureInputSchema>;
type HistoryMap=z.infer<typeof HistorySchema>['maps'][number];
const numeric=(a:string,b:string)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;

function canonical(value:unknown):string {
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(typeof value==='object'&&value!==null&&Object.getPrototypeOf(value)===Object.prototype){
    const obj=value as Record<string,unknown>;
    return '{'+Object.keys(obj).sort().map(k=>JSON.stringify(k)+':'+canonical(obj[k])).join(',')+'}';
  }
  throw Error('non_json_capture_value');
}
export const captureDigest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function freeze<T>(value:T):T {
  if(value&&typeof value==='object'){
    for(const child of Object.values(value))freeze(child);
    Object.freeze(value);
  }
  return value;
}
function unique(values:string[],code:string):void {
  if(new Set(values).size!==values.length)throw Error(code);
}
const pair=(p:{playerId:string;accountId:string})=>`${p.playerId}:${p.accountId}`;

/** The canonical binding fixes A/B and player→hero assignment, ignoring display order only. */
export function selectionDigest(input:unknown,kind:'lineup'|'draft'):string {
  const data=ProspectiveCaptureInputSchema.parse(input);
  const side=(players:CaptureInput['scenario']['teamA'])=>players.slice().sort((a,b)=>numeric(a.playerId,b.playerId))
    .map(p=>kind==='draft'?p:{playerId:p.playerId,accountId:p.accountId});
  return captureDigest({kind,targetMatchId:data.scenario.targetMatchId,scenarioRevision:data.scenarioRevision,
    teamA:side(data.scenario.teamA),teamB:side(data.scenario.teamB)});
}
export const identityDigest=(playerId:string,accountId:string)=>captureDigest({playerId:Id.parse(playerId),accountId:Account.parse(accountId)});
export function historyFactDigest(input:unknown):string {
  const map=HistorySchema.shape.maps.element.parse(input);
  return captureDigest({...map,players:map.players.slice().sort((a,b)=>numeric(a.playerId,b.playerId))});
}

function observationReasons(o:z.infer<typeof Observation>,cutoff:bigint):string[] {
  const reasons:string[]=[];
  if(BigInt(o.fetchedAtUs)>=cutoff)reasons.push('EVIDENCE_FETCH_NOT_BEFORE_CUTOFF');
  if(BigInt(o.observedAtUs)<BigInt(o.fetchedAtUs))reasons.push('OBSERVATION_BEFORE_EVIDENCE_FETCH');
  if(o.sourceKnownAtUs!==null){
    if(BigInt(o.sourceKnownAtUs)>=cutoff)reasons.push('SOURCE_KNOWN_NOT_BEFORE_CUTOFF');
    if(BigInt(o.sourceKnownAtUs)>BigInt(o.observedAtUs))reasons.push('SOURCE_KNOWN_AFTER_OBSERVATION');
  }
  if(BigInt(o.recordedAtUs)<BigInt(o.observedAtUs))reasons.push('OBSERVATION_RECORDED_BEFORE_OBSERVED');
  if(BigInt(o.observedAtUs)>=cutoff)reasons.push('OBSERVATION_NOT_BEFORE_CUTOFF');
  if(BigInt(o.recordedAtUs)>=cutoff)reasons.push('OBSERVATION_NOT_PERSISTED_BEFORE_CUTOFF');
  return reasons;
}

export function createProspectiveCapture(raw:unknown){
  const input=ProspectiveCaptureInputSchema.parse(raw),cutoff=BigInt(input.decisionCutoffAtUs);
  const originalInputSha256=captureDigest(input),scenario=input.scenario;
  if(scenario.cutoffAtUs!==input.decisionCutoffAtUs)throw Error('scenario_cutoff_mismatch');
  if(BigInt(input.snapshotFrozenAtUs)<cutoff)throw Error('snapshot_before_decision_cutoff');
  if(input.syntheticOnly!==input.history.syntheticOnly)throw Error('synthetic_provenance_mismatch');
  if(BigInt(input.history.snapshotAtUs)>BigInt(input.snapshotFrozenAtUs))throw Error('history_snapshot_after_capture');
  // Reuse all original structural/history-clock validations. It does not enforce as-of.
  createPlayerHeroFeatureBuilder(input.history);
  const players=[...scenario.teamA,...scenario.teamB];
  unique(players.map(p=>p.playerId),'duplicate_target_player');
  unique(players.map(p=>p.accountId),'duplicate_target_account');
  unique(players.map(p=>String(p.heroId)),'duplicate_target_hero');
  unique(input.identityObservations.map(p=>p.playerId),'duplicate_identity_observation');
  unique(input.identityObservations.map(p=>p.accountId),'duplicate_identity_account');
  unique(input.historyObservations.map(p=>p.matchId),'duplicate_history_observation');
  const targets=new Set(players.map(pair)),maps=new Map(input.history.maps.map(m=>[m.matchId,m]));
  if(input.identityObservations.some(p=>!targets.has(pair(p))))throw Error('foreign_identity_observation');
  if(input.historyObservations.some(p=>!maps.has(p.matchId)))throw Error('foreign_history_observation');
  const reasons:string[]=[];
  if(scenario.targetMatchId===null)reasons.push('TARGET_MAP_UNRESOLVED');
  if(BigInt(scenario.selectedAtUs)>=cutoff)reasons.push('LINEUP_SELECTED_NOT_BEFORE_CUTOFF');
  for(const [kind,o] of [['lineup',input.lineupObservation],['draft',input.draftObservation]] as const){
    if(!o){reasons.push(`${kind.toUpperCase()}_OBSERVATION_MISSING`);continue;}
    if(o.factSha256!==selectionDigest(input,kind))throw Error(`${kind}_binding_mismatch`);
    if(BigInt(o.observedAtUs)<BigInt(scenario.selectedAtUs))reasons.push(`${kind.toUpperCase()}_OBSERVED_BEFORE_SELECTION`);
    reasons.push(...observationReasons(o,cutoff).map(r=>`${kind.toUpperCase()}_${r}`));
  }
  const identities=new Map(input.identityObservations.map(o=>[pair(o),o]));
  for(const player of players){
    const o=identities.get(pair(player));
    if(!o){reasons.push('IDENTITY_OBSERVATION_MISSING');continue;}
    if(o.factSha256!==identityDigest(player.playerId,player.accountId))throw Error('identity_binding_mismatch');
    reasons.push(...observationReasons(o,cutoff).map(r=>`IDENTITY_${r}`));
  }
  const observations=new Map(input.historyObservations.map(o=>[o.matchId,o]));
  const byPlayer=new Map(players.map(p=>[p.playerId,p.accountId]));
  const byAccount=new Map(players.map(p=>[p.accountId,p.playerId]));
  const accepted:HistoryMap[]=[];
  const ledger=input.history.maps.slice().sort((a,b)=>numeric(a.matchId,b.matchId)).map(map=>{
    const failures:string[]=[];
    const o=observations.get(map.matchId);
    if(map.matchId===scenario.targetMatchId)failures.push('TARGET_MAP_EXCLUDED');
    if(BigInt(map.startedAtUs)>=cutoff)failures.push('HISTORY_START_NOT_BEFORE_CUTOFF');
    if(BigInt(map.completedAtUs)>=cutoff)failures.push('HISTORY_COMPLETION_NOT_BEFORE_CUTOFF');
    if(BigInt(map.fetchedAtUs)>=cutoff)failures.push('HISTORY_FETCH_NOT_BEFORE_CUTOFF');
    if(BigInt(map.fetchedAtUs)<BigInt(map.completedAtUs))failures.push('RECEIPT_FETCH_BEFORE_COMPLETION');
    if(map.knownAtUs!==null&&BigInt(map.knownAtUs)>=cutoff)failures.push('PROVIDER_KNOWN_NOT_BEFORE_CUTOFF');
    if(map.players.some(p=>(byPlayer.has(p.playerId)&&byPlayer.get(p.playerId)!==p.accountId)
        ||(byAccount.has(p.accountId)&&byAccount.get(p.accountId)!==p.playerId)))failures.push('SELECTED_IDENTITY_CONFLICT');
    if(!o)failures.push('HISTORY_OBSERVATION_MISSING');
    else {
      if(o.sourceSha256!==map.receiptSha256||o.factSha256!==historyFactDigest(map)||o.sourceKnownAtUs!==map.knownAtUs)
        throw Error('history_receipt_binding_mismatch');
      failures.push(...observationReasons(o,cutoff));
      if(BigInt(o.fetchedAtUs)<BigInt(map.fetchedAtUs))failures.push('EVIDENCE_FETCH_BEFORE_RECEIPT_FETCH');
      if(BigInt(o.observedAtUs)<BigInt(map.fetchedAtUs))failures.push('OBSERVATION_BEFORE_RECEIPT_FETCH');
      if(map.knownAtUs!==null&&BigInt(o.observedAtUs)<BigInt(map.knownAtUs))failures.push('OBSERVATION_BEFORE_PROVIDER_KNOWN');
      if(o.basis==='provider_known_at'&&map.knownAtUs===null)failures.push('PROVIDER_KNOWN_AT_MISSING');
    }
    if(!failures.length)accepted.push(map);
    return {matchId:map.matchId,included:!failures.length,reasons:failures,
      originalKnownAtUs:map.knownAtUs,fetchedAtUs:map.fetchedAtUs,
      availabilityBasis:o?.basis??null,observedAtUs:o?.observedAtUs??null,recordedAtUs:o?.recordedAtUs??null};
  });
  const availableHistory={...input.history,maps:accepted};
  // Never replace provider known_at with a local observation timestamp.
  const coverage=players.slice().sort((a,b)=>numeric(a.playerId,b.playerId)).map(p=>({playerId:p.playerId,accountId:p.accountId,
    priorProMaps:accepted.filter(m=>m.players.some(h=>pair(h)===pair(p))).length}));
  if(coverage.some(p=>p.priorProMaps<5))reasons.push('ELO_HISTORY_BELOW_FIVE_PRO_MAPS');
  const practice=scenario.targetMatchId!==null
    ?createPlayerHeroFeatureBuilder(availableHistory)({...scenario,targetMatchId:scenario.targetMatchId}):null;
  if(practice?.status==='unavailable')reasons.push(...practice.reasons);
  const uniqueReasons=[...new Set(reasons)].sort();
  const body={format:'player-hero-prospective-capture-v1',syntheticOnly:input.syntheticOnly,
    status:uniqueReasons.length?'unavailable':'validated_offline_contract',
    decisionCutoffAtUs:input.decisionCutoffAtUs,snapshotFrozenAtUs:input.snapshotFrozenAtUs,
    scenarioRevision:input.scenarioRevision,originalInputSha256,input,
    reasons:uniqueReasons,historyLedger:ledger,availableHistory,historyCoverage:coverage,
    observedHeroPracticeLog90Delta:uniqueReasons.length?null:practice?.feature??null,
    practiceDiagnostic:practice,
    warnings:['OFFLINE_EVIDENCE_ASSERTIONS_NOT_AUTHENTICATED','LOCAL_HISTORY_NOT_EXHAUSTIVE',
      'OLD_BUILDER_PROVIDER_KNOWN_COUNTS_AND_CONDITIONAL_WARNINGS_PRESERVED'],
    readiness:{capturePersistenceVerified:false,actualStartVerified:false,eloInferencePrepared:false,
      primaryEligible:false,registrationAllowed:false,collectionAllowed:false},
    trainingPerformed:false,scoringPerformed:false,releaseGatePassed:false,deployable:false};
  return freeze({...body,fingerprint:captureDigest(body)});
}

const StartAssessment=z.object({captureFingerprint:Sha,targetMatchId:Id,
  capturePersistedAtUs:Time,capturePersistenceReceiptSha256:Sha,
  actualGameplayStartedAtUs:Time,startObservedAtUs:Time,startRecordedAtUs:Time,
  actualStartSourceSha256:Sha,clockSemanticsEvidenceSha256:Sha}).strict();

/** Separate post-event clock check; it cannot rewrite inputs or certify a prediction. */
export function assessCaptureTiming(rawCapture:unknown,rawEvidence:unknown){
  const saved=z.object({input:z.unknown(),fingerprint:Sha}).passthrough().parse(rawCapture);
  const replay=createProspectiveCapture(saved.input);
  if(captureDigest(replay)!==captureDigest(saved))throw Error('capture_replay_mismatch');
  const e=StartAssessment.parse(rawEvidence);
  if(e.captureFingerprint!==replay.fingerprint||e.targetMatchId!==replay.input.scenario.targetMatchId)
    throw Error('start_evidence_binding_mismatch');
  const reasons:string[]=[];
  if(replay.status!=='validated_offline_contract')reasons.push('CAPTURE_INPUTS_UNAVAILABLE');
  if(BigInt(e.capturePersistedAtUs)<BigInt(replay.snapshotFrozenAtUs))reasons.push('PERSISTENCE_BEFORE_SNAPSHOT');
  if(BigInt(e.capturePersistedAtUs)>=BigInt(e.actualGameplayStartedAtUs))reasons.push('CAPTURE_NOT_PERSISTED_BEFORE_ACTUAL_START');
  if(BigInt(e.startObservedAtUs)<BigInt(e.actualGameplayStartedAtUs))reasons.push('OBSERVATION_BEFORE_ACTUAL_START');
  if(BigInt(e.startRecordedAtUs)<BigInt(e.startObservedAtUs))reasons.push('START_RECORD_BEFORE_OBSERVATION');
  return freeze({format:'player-hero-capture-timing-assessment-v1',captureFingerprint:replay.fingerprint,
    evidence:e,status:reasons.length?'unavailable':'passes_declared_clock_contract',reasons,
    warnings:['OFFLINE_EVIDENCE_ASSERTIONS_NOT_AUTHENTICATED','CAPTURE_ONLY_NO_PREDICTION_TIME_EVIDENCE'],
    primaryEligible:false,releaseGatePassed:false,deployable:false});
}
