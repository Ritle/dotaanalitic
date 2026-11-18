/** Bounded local collection runner. Remote HTTP and model authorization remain unavailable. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readdir} from 'node:fs/promises';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {sql} from '../../packages/db/dist/index.js';
import {ConditionalCollectionJournal,collectionJournalPaths,CollectionCommandSchema} from './conditional-collection-journal.mjs';
import {LocalConditionalCollectionTransport,collectionTransportPaths} from './conditional-collection-transport.mjs';
import {registeredCollectorPaths} from './conditional-registered-collector.mjs';
import {realSha,requiredRealRegistrationCode,verifyRealRegistrationRuntime} from './conditional-real-registration.mjs';

const Id=z.string().uuid().transform(v=>v.toLowerCase()),Hash=z.string().regex(/^[a-f0-9]{64}$/);
export const CollectionRuntimeRequest=z.object({mode:z.literal('local-synthetic'),ownerId:Id,registrationId:Id,registrationSha256:Hash,
 localOrigin:z.string().url(),maxRequests:z.number().int().min(1).max(20).default(5),
 maxDurationMs:z.number().int().min(100).max(60000).default(60000),newScan:z.boolean().default(false)}).strict();
const Result=CollectionCommandSchema.options[2].shape.result;
const ReceiptProjection=z.object({format:z.literal('conditional-local-transport-receipt-v1'),syntheticOnly:z.literal(true),
 registrationId:Id,requestId:Id,reservationHeadSha256:Hash,endpoint:z.string(),quotaObservationFailed:z.boolean(),
 clientValidationCode:z.string().nullable(),completionOperationId:Id,result:Result}).passthrough();
const runtimeEntries=['tools/research/conditional-collection-runtime.mjs','tools/research/run-conditional-collection.mjs'];
export function collectionHasResponseCapacity(logBytes){
 z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(logBytes);
 // One 1MiB UTF-8 response may expand sixfold inside JSON, plus two events and metadata.
 return logBytes<=67108864-6*1048576-65536;
}
/** Freeze workspace JS dependencies too: barrel imports must not silently select different code. */
export async function collectionRuntimeManifestPaths(){
 const paths=new Set([...runtimeEntries,...requiredRealRegistrationCode,...registeredCollectorPaths,...collectionJournalPaths,...collectionTransportPaths,
  'pnpm-lock.yaml']);
 async function walk(path){for(const entry of await readdir(path,{withFileTypes:true})){
  assert(!entry.isSymbolicLink(),'runtime_symlink_not_supported');const child=path+'/'+entry.name;
  if(entry.isDirectory())await walk(child);else if(entry.isFile()&&entry.name.endsWith('.js'))paths.add(child);
 }}
 for(const name of ['analytics','contracts','prediction','db','ingestion']){paths.add('packages/'+name+'/package.json');await walk('packages/'+name+'/dist');}
 return [...paths].sort();
}
export async function verifyCollectionRuntimeManifest(registration){
 const p=JSON.parse(registration.packageText),paths=await collectionRuntimeManifestPaths();
 for(const path of paths)assert(p.executable.code[path],'runtime_manifest_incomplete');
 await verifyRealRegistrationRuntime(p);return {verifiedFiles:Object.keys(p.executable.code).length,requiredFiles:paths.length};
}
function summary(input,runId,state,status,reason,reserved,finalized){return {
 format:'conditional-local-collection-run-v1',syntheticOnly:true,registrationId:input.registrationId,runId,status,reason,
 reservationsAcknowledgedThisRun:reserved,responsesResumedThisRun:finalized,headSha256:state?.headSha256??null,
 attemptsObservedTotal:state?.report.attempts.total??null,lastRequestId:state?.report.requests.at(-1)?.requestId??null,
 retryAfterAt:state?.report.cooldownUntil??null,observedPossibleMaps:state?.report.observedPossibleMaps??null,
 denominatorComplete:false,verifiedProMaps:null,remoteCollectionAllowed:false,collectionAllowed:false,
 realEvaluationAllowed:false,activationAllowed:false,deployable:false};}

export class LocalConditionalCollectionRuntime{
 constructor(db){this.db=db;this.journal=new ConditionalCollectionJournal(db);}
 async receiptHealth(registrationId){
  // Inspect hashes in SQL without copying the whole raw archive into another JS buffer.
  const row=(await sql`SELECT
   coalesce(bool_or(receipt_sha256<>encode(sha256(convert_to(receipt_text,'UTF8')),'hex')),false) AS bad_hash,
   coalesce(bool_or((receipt_text::jsonb->>'quotaObservationFailed')::boolean),false) AS quota_failed
   FROM conditional_transport_receipts WHERE registration_id=${registrationId}::uuid`.execute(this.db)).rows[0];
  assert(!row.bad_hash,'runtime_receipt_hash');return {quotaFailed:row.quota_failed};
 }
 async pendingReceipt(registrationId,requestId){
  const row=(await sql`SELECT receipt_text,receipt_sha256 FROM conditional_transport_receipts
   WHERE registration_id=${registrationId}::uuid AND request_id=${requestId}::uuid`.execute(this.db)).rows[0];
  if(!row)return null;assert.equal(realSha(row.receipt_text),row.receipt_sha256,'runtime_receipt_hash');
  const r=ReceiptProjection.parse(JSON.parse(row.receipt_text));assert.equal(r.registrationId,registrationId);assert.equal(r.requestId,requestId);return r;
 }
 async run(raw,{signal}={}){
  const input=CollectionRuntimeRequest.parse(raw),runId=randomUUID(),{ownerId,registrationId}=input;
  // Validate loopback options before DB mutations; no caller-supplied remote client or ready flag.
  const transport=new LocalConditionalCollectionTransport(this.db,{localOrigin:input.localOrigin});
  const registration=await this.journal.registration(ownerId,registrationId);
  assert.equal(registration.packageSha256,input.registrationSha256,'expected_registration_hash');
  await verifyCollectionRuntimeManifest(registration);
  let state=null,reserved=0,finalized=0;
  const result=(status,reason)=>summary(input,runId,state,status,reason,reserved,finalized);
  if(signal?.aborted)return result('stopped','cancelled');
  return this.db.connection().execute(async connection=>{
   const key='conditional-runtime:'+registrationId;
   const locked=(await sql`SELECT pg_try_advisory_lock(hashtextextended(${key},0)) AS locked`.execute(connection)).rows[0].locked;
   if(!locked)return result('busy','another_runner_active');
   const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),input.maxDurationMs);
   const combined=signal?AbortSignal.any([signal,deadline.signal]):deadline.signal;
   const interrupted=()=>combined.aborted?result('stopped',signal?.aborted?'cancelled':'run_duration_limit'):null;
   try{
    const at=new Date((await sql`SELECT conditional_collection_clock() AS at`.execute(connection)).rows[0].at).toISOString();
    // Do not create a journal or a scan before the registered window.
    if(at<registration.plan.window.from)return result('stopped','collection_not_started');
    if(interrupted())return interrupted();
    state=await this.journal.initialize(ownerId,registrationId,input.registrationSha256,{syntheticOnly:true});
    const health=await this.receiptHealth(registrationId),pending=state.report.requests.find(r=>r.status==='in_flight');
    if(pending){
     const receipt=await this.pendingReceipt(registrationId,pending.requestId);
     if(!receipt)return result('blocked','inflight_outcome_unknown');
     // Persistence recovery is allowed after the window; it never grants new dispatch permission.
     state=await transport.finalize(ownerId,registrationId,pending.requestId);finalized++;
    }
    if(health.quotaFailed)return result('blocked','quota_observation_failed');
    const previous=state.report.requests.at(-1);
    if(previous?.status==='invalid_response')return result('blocked','invalid_source_response');
    if(state.report.reasons.includes('COLLECTION_WINDOW_CLOSED'))return result('stopped','collection_window_closed');
    if(input.newScan&&state.report.scans.length){
     if(state.report.nextRequest!==null)return result('blocked','unfinished_scan_cannot_reset');
     if(state.report.reasons.some(r=>['PROVIDER_AUTH_FAILED','RETRY_AFTER','TOTAL_BUDGET_EXHAUSTED','DAILY_BUDGET_EXHAUSTED','TARGET_BUDGET_EXCEEDED'].includes(r)))
      return result('stopped','collection_gate_closed');
     state=await this.journal.append(ownerId,registrationId,state.headSha256,randomUUID(),{kind:'scan',scanId:randomUUID()});
    }
    while(true){
     if(interrupted())return interrupted();
     // Re-read to respect manual recovery, changed quota observations and a closing window.
     await sql`SELECT 1`.execute(connection);
     state=await transport.ready(ownerId,registrationId);
     if((await this.receiptHealth(registrationId)).quotaFailed)return result('blocked','quota_observation_failed');
     const last=state.report.requests.at(-1);
     if(last?.status==='in_flight')return result('blocked','inflight_outcome_unknown');
     if(last?.status==='invalid_response')return result('blocked','invalid_source_response');
     const next=state.report.nextRequest;
     if(!next){
      const stopped=state.report.reasons.find(r=>['COLLECTION_NOT_STARTED','COLLECTION_WINDOW_CLOSED','PROVIDER_AUTH_FAILED','RETRY_AFTER',
       'TOTAL_BUDGET_EXHAUSTED','DAILY_BUDGET_EXHAUSTED','TARGET_BUDGET_EXCEEDED'].includes(r));
      return stopped?result('stopped',stopped.toLowerCase()):result('complete','scan_complete_not_denominator_verified');
     }
     if(reserved>=input.maxRequests)return result('stopped','run_request_limit');
     if(!collectionHasResponseCapacity(Buffer.byteLength(JSON.stringify(state.log))))return result('blocked','journal_capacity_low');
     if(next.requiresScanStart){state=await this.journal.append(ownerId,registrationId,state.headSha256,randomUUID(),{kind:'scan',scanId:randomUUID()});continue;}
     if(interrupted())return interrupted();
     const response=await transport.execute({ownerId,registrationId,expectedHeadSha256:state.headSha256,operationId:randomUUID(),requestId:randomUUID(),endpoint:next.endpoint},{signal:combined});
     if(response.status!=='completed')return result('blocked','reservation_not_new');
     reserved++;state=response.state;
     if(response.quotaObservationFailed)return result('blocked','quota_observation_failed');
     if(state.report.requests.at(-1)?.status==='invalid_response')return result('blocked','invalid_source_response');
     if(response.clientValidationCode||state.report.requests.at(-1)?.status==='failed')return result('stopped','transport_attempt_failed');
    }
   }catch{
    // No raw provider/DB exception text, credentials or bodies in the CLI report. Do not retry uncertain writes.
    state=null;return result('blocked','runtime_step_failed_inspect_journal');
   }finally{clearTimeout(timer);await sql`SELECT pg_advisory_unlock(hashtextextended(${key},0))`.execute(connection);}
  });
 }
}
