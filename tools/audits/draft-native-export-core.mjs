/** Read-only diagnostic bridge. Never invent pre-cutoff observations from a later binding. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {registryHash} from '../../packages/db/dist/index.js';
import {DraftCaptureSavedSchema,CaptureTimeSchema} from '../../apps/api/dist/modules/scenarios/draft-capture-contract.js';
import {DraftTargetCandidateSchema,captureMicros} from '../../apps/api/dist/modules/scenarios/draft-target-resolution.js';
import {DraftNativeResultSchema} from '../../apps/api/dist/modules/scenarios/draft-native-contract.js';
import {verifyNativeDraft} from '../../apps/api/dist/modules/scenarios/draft-native-verify.js';
import {createProspectiveCapture} from '../../.tools/s304-prospective-features-runtime/player-hero-prospective-capture.mjs';
import {buildProspectivePlayerHeroFeatures} from '../../.tools/s304-prospective-features-runtime/player-hero-prospective-features.mjs';
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const Hash=z.string().regex(/^[a-f0-9]{64}$/),Id=z.string().regex(/^[1-9]\d{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n);
const CaptureRow=z.object({id:z.uuid(),ownerId:z.uuid(),scenarioId:z.uuid(),revision:z.number().int().positive(),
  recordedAt:CaptureTimeSchema,snapshotText:z.string().max(33554432),snapshotSha256:Hash}).strict();
const BindingRow=z.object({id:z.uuid(),ownerId:z.uuid(),captureId:z.uuid(),matchId:Id,status:z.enum(['verified','unavailable']),
  inspectedAt:CaptureTimeSchema,recordedAt:CaptureTimeSchema,evidenceText:z.string().max(2097152),evidenceSha256:Hash}).strict();
export const NativeExportSourceSchema=z.object({format:z.literal('native-draft-export-source-v1'),exportedAt:CaptureTimeSchema,
  syntheticOnly:z.boolean(),captures:z.array(CaptureRow).max(100),bindings:z.array(BindingRow).max(1000)}).strict();
const Evidence=z.object({format:z.literal('owner-draft-native-evidence-v1'),candidate:DraftTargetCandidateSchema.nullable(),result:DraftNativeResultSchema}).strict();
const unique=(values,reason)=>assert.equal(new Set(values).size,values.length,reason);
const numeric=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}

function historyLedger(capture,targetId){
  const h=capture.snapshot.history,{status:_status,sha256:hash,...body}=h;
  assert.equal(registryHash(body),hash,'history_hash_mismatch');unique(h.maps.map(m=>m.id),'duplicate_history_map');
  const cutoff=captureMicros(capture.snapshot.decisionCutoffAt);
  const playersByMap=new Map(),receiptMaps=new Set(h.receipts.map(r=>r.canonical_match_id));
  for(const player of h.players){const rows=playersByMap.get(player.match_id)??[];rows.push(player);playersByMap.set(player.match_id,rows);}
  return h.maps.map(m=>{
    const reasons=['OUTCOME_VERIFICATION_OBSERVATION_NOT_CAPTURED','HISTORY_AVAILABILITY_OBSERVATION_NOT_CAPTURED'];
    if(m.id===targetId)reasons.push('TARGET_MAP_EXCLUDED');
    if(BigInt(m.started_at_us)>=cutoff)reasons.push('HISTORY_START_NOT_BEFORE_CUTOFF');
    if(m.duration_seconds===null||m.duration_seconds<=0)reasons.push('COMPLETION_UNKNOWN');
    else if(BigInt(m.started_at_us)+BigInt(m.duration_seconds)*1000000n>=cutoff)reasons.push('HISTORY_COMPLETION_NOT_BEFORE_CUTOFF');
    if(m.ingest_state==='conflict')reasons.push('MAP_CONFLICT');
    const players=playersByMap.get(m.id)??[];
    if(players.length!==10||players.some(p=>p.player_id===null||p.source_account_id===null)||
      new Set(players.map(p=>p.source_account_id)).size!==10)reasons.push('HISTORY_IDENTITIES_INCOMPLETE');
    if(!receiptMaps.has(m.id))reasons.push('HISTORY_RECEIPT_MISSING');
    return {matchId:m.id,seriesId:m.series_id,eligibleForFeatures:false,reasons};
  }).sort((a,b)=>numeric(a.matchId,b.matchId));
}

/** Exercise the unchanged offline contract with only evidence actually available for its trusted boundary.
 * Empty trusted history is explicit; raw inventory is retained separately, never called zero experience.
 * No before-cutoff selection/identity/outcome observation is fabricated here.
 */
function featureGapCheck(capture,matchId,syntheticOnly){
  const c=capture.snapshot,cutoff=captureMicros(c.decisionCutoffAt).toString();
  const players=c.players;
  if(players.some(p=>p.accountId===null||p.heroId===null||p.identityStatus!=='verified')||
    new Set(players.map(p=>p.accountId)).size!==10||new Set(players.map(p=>p.heroId)).size!==10)
    return {status:'not_run',mode:'missing_evidence_probe',reasons:['CAPTURE_PLAYERS_UNRESOLVED'],trustedHistoryMaps:0,inputs:null};
  const side=slot=>players.filter(p=>p.teamSlot===slot).map(p=>({playerId:p.playerId,accountId:p.accountId,heroId:p.heroId}));
  const snapshotAtUs=captureMicros(capture.recordedAt).toString();
  const input={format:'player-hero-prospective-input-v1',syntheticOnly,decisionCutoffAtUs:cutoff,snapshotFrozenAtUs:snapshotAtUs,
    scenarioRevision:String(c.revision),scenario:{targetMatchId:matchId,cutoffAtUs:cutoff,teamA:side('A'),teamB:side('B'),canonicalPatchId:null,
      heroBasis:'owner_selected',selectedAtUs:captureMicros(c.scenarioRecordedAt).toString(),sourceSha256:capture.sha256},
    history:{format:'verified-player-hero-history-v1',syntheticOnly,sourceSha256:c.history.sha256,fromAtUs:'0',toAtUs:cutoff,snapshotAtUs,maps:[]},
    lineupObservation:null,draftObservation:null,identityObservations:[],historyObservations:[]};
  const adapted=createProspectiveCapture(input);
  const result=buildProspectivePlayerHeroFeatures({format:'player-hero-prospective-features-input-v1',capture:adapted,
    history:{schemaVersion:1,profile:'player-mean-elo-completed-strict-v1',sourceFingerprint:c.history.sha256,identityRevision:'0',
      snapshotAtUs,warmupFromAtUs:'0',syntheticOnly,identities:[],maps:[]},outcomeObservations:[],identityObservations:[]});
  assert.equal(result.status,'unavailable');assert.equal(result.inputs,null);assert.equal(result.teamAWinProbability,null);
  return {status:result.status,mode:'missing_evidence_probe',reasons:[...new Set([...adapted.reasons,...result.reasons])].sort(),
    trustedHistoryMaps:0,inputFingerprint:result.inputSha256,resultFingerprint:result.fingerprint,inputs:null};
}

export function auditNativeExport(raw){
  assert(Buffer.byteLength(JSON.stringify(raw))<=64*1024*1024,'source_size_limit');
  const source=NativeExportSourceSchema.parse(raw),at=captureMicros(source.exportedAt);
  unique(source.captures.map(c=>c.id),'duplicate_capture');unique(source.bindings.map(b=>b.id),'duplicate_binding');
  unique(source.captures.map(c=>[c.ownerId,c.scenarioId,c.revision].join(':')),'duplicate_revision');
  const captures=new Map(source.captures.map(row=>{
    assert.equal(sha(row.snapshotText),row.snapshotSha256,'capture_hash_mismatch');
    const saved=DraftCaptureSavedSchema.parse({id:row.id,sha256:row.snapshotSha256,recordedAt:row.recordedAt,snapshot:JSON.parse(row.snapshotText)});
    assert.equal(saved.snapshot.scenarioId,row.scenarioId);assert.equal(saved.snapshot.revision,row.revision);
    assert(captureMicros(saved.snapshot.scenarioRecordedAt)<=captureMicros(saved.snapshot.decisionCutoffAt));
    assert(captureMicros(saved.snapshot.decisionCutoffAt)<=captureMicros(row.recordedAt)&&captureMicros(row.recordedAt)<=at,'capture_clock');
    return [row.id,{row,saved,attempts:[]}];
  }));
  for(const row of source.bindings){
    const c=captures.get(row.captureId);assert(c&&c.row.ownerId===row.ownerId,'foreign_binding');
    assert.equal(sha(row.evidenceText),row.evidenceSha256,'binding_hash_mismatch');
    const e=Evidence.parse(JSON.parse(row.evidenceText));
    assert.equal(e.result.captureId,row.captureId);assert.equal(e.result.matchId,row.matchId);
    assert.equal(e.result.status,row.status);assert.equal(e.result.inspectedAt,row.inspectedAt);
    assert(captureMicros(row.inspectedAt)>=captureMicros(c.row.recordedAt)&&captureMicros(row.inspectedAt)<=captureMicros(row.recordedAt)&&captureMicros(row.recordedAt)<=at,'binding_clock');
    assert.deepEqual(e.result,verifyNativeDraft({capture:c.saved,matchId:row.matchId,inspectedAt:row.inspectedAt,candidate:e.candidate}),'binding_replay_mismatch');
    c.attempts.push({id:row.id,sha256:row.evidenceSha256,recordedAt:row.recordedAt,result:e.result});
  }
  const groups=new Map();
  const items=[...captures.values()].map(({row,saved,attempts})=>{
    attempts.sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)||a.id.localeCompare(b.id));
    const successful=attempts.filter(a=>a.result.status==='verified');assert(successful.length<=1,'multiple_verified_bindings');
    const bound=successful[0],targetId=bound?.result.matchId??null,history=historyLedger(saved,targetId);
    const item={captureId:row.id,captureSha256:row.snapshotSha256,scenarioId:row.scenarioId,revision:row.revision,recordedAt:row.recordedAt,
      actualMatchId:targetId,bindingId:bound?.id??null,attempts,diagnosticRepresentative:false,duplicateOf:null,
      reasons:[...saved.snapshot.reasons,'ACTUAL_GAMEPLAY_START_UNVERIFIED','PRE_CUTOFF_FEATURE_OBSERVATIONS_NOT_CAPTURED',
        ...(targetId?[]:['VERIFIED_NATIVE_BINDING_MISSING']),...(bound?.result.temporalStatus==='not_before_provider_start'?['CAPTURE_NOT_BEFORE_PROVIDER_START']:[])],
      frozenHistoryMaps:history.length,historyLedger:history,featureCheck:featureGapCheck(saved,targetId,source.syntheticOnly),
      primaryEligible:false,trainingExample:false,deployable:false};
    if(targetId){const group=groups.get(targetId)??[];group.push(item);groups.set(targetId,group);}return item;
  });
  const maps=[...groups.entries()].sort(([a],[b])=>numeric(a,b)).map(([matchId,rows])=>{
    rows.sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)||a.captureId.localeCompare(b.captureId));
    rows[0].diagnosticRepresentative=true;
    for(const row of rows.slice(1)){row.duplicateOf=rows[0].captureId;row.reasons.push('DUPLICATE_ACTUAL_MAP');}
    return {matchId,representativeCaptureId:rows[0].captureId,captureIds:rows.map(r=>r.captureId),trainingEligible:false};
  });
  items.sort((a,b)=>a.captureId.localeCompare(b.captureId));for(const row of items)row.reasons=[...new Set(row.reasons)].sort();
  return freeze({format:'native-draft-export-audit-v1',exportedAt:source.exportedAt,syntheticOnly:source.syntheticOnly,items,maps,
    counts:{captures:items.length,bindingAttempts:source.bindings.length,verifiedBindings:items.filter(i=>i.actualMatchId!==null).length,
      distinctActualMaps:maps.length,duplicateCaptures:items.filter(i=>i.duplicateOf!==null).length,unboundCaptures:items.filter(i=>i.actualMatchId===null).length,
      featureReady:0,trainingExamples:0},representativePolicy:'earliest_capture_recorded_at_then_capture_id_among_verified_bindings_not_a_primary_forecast',
    historyPolicy:'frozen_inventory_preserved_no_invented_outcome_or_availability_observations',
    primaryEligible:false,trainingPerformed:false,scoringPerformed:false,deployable:false,teamAWinProbability:null});
}
