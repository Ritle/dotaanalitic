/** Replay committed SQL061 results. Binding/outcome observations never replace their frozen inputs. */
import assert from 'node:assert/strict';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {CaptureTimeSchema,DraftCaptureSavedSchema} from '../../apps/api/dist/modules/scenarios/draft-capture-contract.js';
import {DraftHistorySavedSchema} from '../../apps/api/dist/modules/scenarios/draft-history-contract.js';
import {ShadowResultSchema} from '../../apps/api/dist/modules/scenarios/draft-shadow-contract.js';
import {calculateDraftShadow,parseShadowCandidate} from '../../apps/api/dist/modules/scenarios/draft-shadow-runtime.js';
import {ObservationFeatureSourceSchema,auditObservationFeatures} from './draft-observation-features-core.mjs';
import {sha} from './draft-native-export-core.mjs';
const Hash=z.string().regex(/^[a-f0-9]{64}$/),Txid=z.string().regex(/^[1-9]\d*$/).max(20),Time=CaptureTimeSchema;
export const CommittedShadowSourceSchema=z.object({format:z.literal('committed-draft-shadow-source-v1'),history:ObservationFeatureSourceSchema,
 runs:z.array(z.object({id:z.uuid(),captureId:z.uuid(),ownerId:z.uuid(),resultText:z.string().max(16777216),resultSha256:Hash,
   recordedAt:Time,writerTxid:Txid}).strict()).max(100),
 receipts:z.array(z.object({runId:z.uuid(),resultSha256:Hash,observedCommittedAt:Time,observerTxid:Txid}).strict()).max(100)
}).strict();
const unique=(xs,reason)=>assert.equal(new Set(xs).size,xs.length,reason);
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};

export function auditCommittedShadow(raw,implementationSha256){
 assert(Buffer.byteLength(JSON.stringify(raw))<=256*1024*1024,'source_size_limit');Hash.parse(implementationSha256);
 const source=CommittedShadowSourceSchema.parse(raw),h=source.history,exportedAt=h.native.exportedAt;
 // This verifies SQL058/059/060 hashes, clocks, owners and native bindings. Its diagnostic features are discarded.
 const historyAudit=auditObservationFeatures(h);
 unique(source.runs.map(r=>r.id),'duplicate_run');unique(source.runs.map(r=>r.captureId),'duplicate_capture_run');
 unique(source.receipts.map(r=>r.runId),'duplicate_commit_receipt');
 const captures=new Map(h.native.captures.map(c=>[c.id,c])),observations=new Map(h.observations.map(o=>[o.id,o]));
 const links=new Map(h.links.map(l=>[l.captureId,l])),runs=new Map(),receipts=new Map();
 for(const row of source.runs){
   const c=captures.get(row.captureId);assert(c&&c.ownerId===row.ownerId,'foreign_shadow_owner_or_capture');
   assert.equal(sha(row.resultText),row.resultSha256,'shadow_result_sha_mismatch');
   const result=ShadowResultSchema.parse(JSON.parse(row.resultText));
   assert.equal(result.implementationSha256,implementationSha256,'shadow_implementation_changed');
   assert(c.recordedAt<=result.calculatedAt&&result.calculatedAt<=row.recordedAt&&row.recordedAt<=exportedAt,'shadow_clock');
   assert(!result.syntheticOnly||h.native.syntheticOnly,'synthetic_result_on_real_source');
   const link=links.get(c.id),o=link?observations.get(link.observationId):null;
   if(link)assert(link.recordedAt<=result.calculatedAt,'shadow_before_history_link');
   const capture=DraftCaptureSavedSchema.parse({id:c.id,sha256:c.snapshotSha256,recordedAt:c.recordedAt,snapshot:JSON.parse(c.snapshotText)});
   const observation=o?DraftHistorySavedSchema.parse({id:o.id,sha256:o.evidenceSha256,recordedAt:o.recordedAt,evidence:JSON.parse(o.evidenceText)}):null;
   const candidate=result.candidate?parseShadowCandidate(result.candidate.artifactText,h.native.syntheticOnly):null;
   assert.deepEqual(result,calculateDraftShadow(capture,observation,candidate,result.calculatedAt,implementationSha256),'committed_shadow_replay_mismatch');
   runs.set(c.id,{row,result});
 }
 const byRun=new Map([...runs.values()].map(r=>[r.row.id,r]));
 for(const receipt of source.receipts){
   const run=byRun.get(receipt.runId);assert(run,'orphan_commit_receipt');
   assert.equal(receipt.resultSha256,run.row.resultSha256,'commit_receipt_sha_mismatch');
   assert(receipt.observerTxid!==run.row.writerTxid,'same_transaction_receipt');
   assert(run.row.recordedAt<=receipt.observedCommittedAt&&receipt.observedCommittedAt<=exportedAt,'commit_receipt_clock');
   receipts.set(receipt.runId,receipt);
 }
 const items=historyAudit.items.map(n=>{
   const run=runs.get(n.captureId),receipt=run?receipts.get(run.row.id):null;
   return {captureId:n.captureId,actualMatchId:n.actualMatchId,bindingAttempts:n.attempts,
     status:!run?'missing':!receipt?'awaiting_receipt':run.result.status,
     runId:run?.row.id??null,resultSha256:run?.row.resultSha256??null,
     recordedAt:run?.row.recordedAt??null,observedCommittedAt:receipt?.observedCommittedAt??null,
     frozenInputs:run?.result.features.inputs??null,researchScores:run?.result.researchScores??null,
     diagnosticRepresentative:false,duplicateOf:null,
     reasons:[...new Set(['ACTUAL_GAMEPLAY_START_UNVERIFIED','POST_DRAFT_MODEL_NOT_ACTIVATED',
       ...(n.actualMatchId?[]:['VERIFIED_NATIVE_BINDING_MISSING']),...(run?.result.reasons??['SHADOW_RESULT_MISSING']),
       ...(run&&!receipt?['SHADOW_COMMIT_RECEIPT_MISSING']:[])])].sort(),
     primaryEligible:false,trainingExample:false,teamAWinProbability:null};
 }).sort((a,b)=>a.captureId.localeCompare(b.captureId));
 const groups=new Map();for(const item of items)if(item.actualMatchId){const rows=groups.get(item.actualMatchId)??[];rows.push(item);groups.set(item.actualMatchId,rows);}
 const maps=[...groups.entries()].sort(([a],[b])=>BigInt(a)<BigInt(b)?-1:1).map(([matchId,rows])=>{
   const committed=rows.filter(r=>r.status==='computed_shadow_only').sort((a,b)=>a.observedCommittedAt.localeCompare(b.observedCommittedAt)||a.runId.localeCompare(b.runId));
   const representative=committed[0];if(representative)representative.diagnosticRepresentative=true;
   for(const row of rows)if(representative&&row!==representative){row.duplicateOf=representative.captureId;row.reasons.push('DUPLICATE_ACTUAL_MAP');row.reasons.sort();}
   return {matchId,captureIds:rows.map(r=>r.captureId),representativeCaptureId:representative?.captureId??null,primaryEligible:false,trainingExample:false};
 });
 return freeze({format:'committed-draft-shadow-audit-v1',exportedAt,syntheticOnly:h.native.syntheticOnly,implementationSha256,items,maps,
   counts:{captures:items.length,runs:source.runs.length,receipts:source.receipts.length,observations:h.observations.length,links:h.links.length,
     bindingAttempts:h.native.bindings.length,missingResults:items.filter(i=>i.status==='missing').length,
     awaitingReceipts:items.filter(i=>i.status==='awaiting_receipt').length,committedComputed:items.filter(i=>i.status==='computed_shadow_only').length,
     committedUnavailable:items.filter(i=>i.status==='unavailable').length,distinctActualMaps:maps.length,
     distinctCommittedComputedMaps:maps.filter(m=>m.representativeCaptureId!==null).length,primaryExamples:0,trainingExamples:0},
   unlinkedObservationIds:historyAudit.unlinkedObservationIds,
   representativePolicy:'earliest_commit_receipt_then_run_id_among_computed_verified_native_bindings_diagnostic_only',
   assumptions:['OFFLINE_HASH_REPLAY_IS_NOT_DATABASE_AUTHENTICATION','COMMIT_RECEIPT_IS_NOT_GAMEPLAY_START_EVIDENCE',
     'SAVED_SCORES_ARE_REPLAYED_NOT_REPLACED','NATIVE_BINDINGS_DO_NOT_REBUILD_FROZEN_FEATURES','GLOBAL_EXPOSURE_AND_DENOMINATOR_UNVERIFIED'],
   replayPerformed:true,trainingPerformed:false,collectionAllowed:false,primaryEligible:false,deployable:false,teamAWinProbability:null});
}
