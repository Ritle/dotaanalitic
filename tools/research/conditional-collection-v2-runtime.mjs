/** One bounded local synthetic sweep. No remote dispatch, experiment registration or model promotion. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {sql} from '../../packages/db/dist/index.js';
import {registrationV2ManifestPaths,verifyRegistrationV2Runtime} from './conditional-real-registration-v2.mjs';
import {ConditionalCollectionV2Journal,collectionV2JournalPaths} from './conditional-collection-v2-journal.mjs';
import {LocalConditionalCollectionV2Transport,collectionV2TransportPaths,localV2Origin} from './conditional-collection-v2-transport.mjs';
import {ConditionalCollectionV2Discovery,collectionV2DiscoveryPaths} from './conditional-collection-v2-discovery.mjs';
import {archiveCodePaths,archiveLimits} from './conditional-blob-archive.mjs';
import {parseBindingEvidenceJson as parse} from './conditional-tournament-binding-v2.mjs';
const Id=z.string().uuid().transform(v=>v.toLowerCase()),Hash=z.string().regex(/^[a-f0-9]{64}$/);
export const CollectionV2RuntimeRequest=z.object({mode:z.literal('local-synthetic'),ownerId:Id,registrationId:Id,registrationSha256:Hash,
 localOrigin:z.string().refine(v=>{try{localV2Origin(v);return true;}catch{return false;}},'literal_loopback_origin_required'),
 maxRequests:z.number().int().min(1).max(20).default(5),maxDurationMs:z.number().int().min(100).max(60000).default(60000)}).strict();
export const collectionV2RuntimePaths=['tools/research/conditional-collection-v2-runtime.mjs','tools/research/run-conditional-collection-v2.mjs'];
export async function collectionV2RuntimeManifestPaths(){return [...new Set([...await registrationV2ManifestPaths(),...archiveCodePaths,
 ...collectionV2JournalPaths,...collectionV2TransportPaths,...collectionV2DiscoveryPaths,...collectionV2RuntimePaths])].sort();}
export function temporaryCollectionV2Database(value){const url=new URL(value);
 assert(['postgres:','postgresql:'].includes(url.protocol)&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)
  &&/^\/codex_ingest_[a-f0-9]{12}$/.test(url.pathname),'temporary_local_database_required');return url;}
export async function verifyCollectionV2RuntimeManifest(registration){const p=parse(registration.packageText);
 for(const path of await collectionV2RuntimeManifestPaths())Hash.parse(p.executable.code[path]);
 await verifyRegistrationV2Runtime(p);return {verifiedFiles:Object.keys(p.executable.code).length};}
const closed={remoteCollectionAllowed:false,collectionAllowed:false,realEvaluationAllowed:false,activationAllowed:false,deployable:false,denominatorComplete:false,verifiedProMaps:null};
const stops=['COLLECTION_NOT_STARTED','COLLECTION_WINDOW_CLOSED','PROVIDER_AUTH_FAILED','RETRY_AFTER','TOTAL_BUDGET_EXHAUSTED','DAILY_BUDGET_EXHAUSTED','TARGET_BUDGET_EXCEEDED'];
export class LocalConditionalCollectionV2Runtime{
 constructor(db){this.db=db;this.journal=new ConditionalCollectionV2Journal(db);this.discovery=new ConditionalCollectionV2Discovery(db);}
 async run(raw,{signal}={}){
  const input=CollectionV2RuntimeRequest.parse(raw),runId=randomUUID(),{ownerId,registrationId}=input;
  const transport=new LocalConditionalCollectionV2Transport(this.db,{localOrigin:input.localOrigin});
  let state=null,report=null,reserved=0,finalized=0,wire=0;
  const result=(status,reason)=>({format:'conditional-local-collection-run-v2',syntheticOnly:true,registrationId,runId,status,reason,
   reservationsAcknowledgedThisRun:reserved,dispatchesAcknowledgedThisRun:wire,responsesResumedThisRun:finalized,
   journalHeadSha256:state?.headSha256??null,discoveryFingerprint:report?.fingerprint??null,attemptsObservedTotal:state?.attempts.total??null,
   observedPossibleMaps:report?.observedPossibleMaps??null,lastRequestId:state?.requests.at(-1)?.requestId??null,
   retryAfterAt:state?.cooldownUntil??null,countsComplete:state!==null,...closed});
  const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),input.maxDurationMs);
  const combined=signal?AbortSignal.any([signal,deadline.signal]):deadline.signal;
  const interrupted=()=>combined.aborted?result('stopped',signal?.aborted?'cancelled':'run_duration_limit'):null;
  try{
   if(interrupted())return interrupted();
   const registration=await this.journal.registration(ownerId,registrationId);assert.equal(registration.packageSha256,input.registrationSha256,'expected_registration_hash');
   await verifyCollectionV2RuntimeManifest(registration);if(interrupted())return interrupted();
   return await this.db.connection().execute(async connection=>{
    const key='conditional-runtime-v2:'+registrationId;
    const locked=(await sql`SELECT pg_try_advisory_lock(hashtextextended(${key},0)) AS locked`.execute(connection)).rows[0].locked;
    if(!locked)return result('busy','another_runner_active');
    try{
     const at=new Date((await sql`SELECT conditional_collection_clock() AS at`.execute(connection)).rows[0].at).toISOString();
     if(at<registration.plan.window.from)return result('stopped','collection_not_started');if(interrupted())return interrupted();
     const existing=(await sql`SELECT a.synthetic_only,a.max_bytes,a.max_responses,j.registration_id AS journal_id FROM conditional_blob_archives a
      LEFT JOIN conditional_collection_v2_journals j ON j.registration_id=a.registration_id WHERE a.registration_id=${registrationId}::uuid`.execute(connection)).rows[0];
     if(at>=registration.plan.window.assessmentAt&&!existing?.journal_id)return result('stopped','collection_window_closed');
     assert(!existing||existing.synthetic_only,'v2_synthetic_runtime_only');
     state=await this.journal.initialize(ownerId,registrationId,input.registrationSha256,{syntheticOnly:true,
      maxBytes:existing?Number(existing.max_bytes):archiveLimits.globalBytes,maxResponses:existing?.max_responses??1000});
     while(true){
      if(interrupted())return interrupted();await sql`SELECT 1`.execute(connection);
      const ready=await transport.ready(ownerId,registrationId);state=ready.state;report=null;
      if(state.pendingRequest){
       const receipt=ready.retained.find(r=>r.requestId===state.pendingRequest.requestId);
       if(!receipt)return result('blocked','inflight_outcome_unknown');
       if(interrupted())return interrupted();
       // Recovery is allowed after assessment, never grants a fresh request or refunds an attempt.
       state=await transport.finalize(ownerId,registrationId,receipt.requestId);finalized++;
       if(receipt.quotaObservationFailed)return result('blocked','quota_observation_failed');
       continue;
      }
      if(ready.retained.some(r=>r.quotaObservationFailed))return result('blocked','quota_observation_failed');
      const projection=await this.discovery.read(ownerId,registrationId);report=projection.report;
      assert.equal(report.journalHeadSha256,state.headSha256,'runtime_snapshot_changed');
      if(interrupted())return interrupted();
      if(report.reasons.includes('INVALID_DISCOVERY_RESPONSE'))return result('blocked','invalid_source_response');
      if(report.reasons.includes('UNKNOWN_REQUEST_OUTCOME_REQUIRES_REVIEW'))return result('blocked','unknown_outcome_requires_review');
      const stop=stops.find(code=>report.reasons.includes(code));if(stop)return result('stopped',stop.toLowerCase());
      if(!report.nextRequest)return result('complete','sweep_complete_not_denominator_verified');
      if(reserved>=input.maxRequests)return result('stopped','run_request_limit');
      const capacity=await this.journal.archive.capacity(ownerId,registrationId);if(!capacity.canFitMaximumBody)return result('blocked','archive_capacity_low');
      if(interrupted())return interrupted();await sql`SELECT 1`.execute(connection);
      const sent=await transport.execute({ownerId,registrationId,expectedHeadSha256:state.headSha256,operationId:randomUUID(),requestId:randomUUID(),
       endpoint:report.nextRequest.endpoint},{signal:combined});
      if(sent.status!=='completed')return result('blocked','reservation_not_new');
      reserved++;if(sent.dispatchPerformed)wire++;state=sent.state;report=null;
      if(sent.quotaObservationFailed)return result('blocked','quota_observation_failed');
      if(interrupted())return interrupted();
      if(sent.clientValidationCode||state.requests.at(-1)?.status==='failed')return result('stopped','transport_attempt_failed');
     }
    }finally{await sql`SELECT pg_advisory_unlock(hashtextextended(${key},0))`.execute(connection);}
   });
  }catch{
   // An uncertain write must be inspected/recovered on a later invocation, never blindly resent.
   state=null;report=null;return result('blocked','runtime_step_failed_inspect_journal');
  }finally{clearTimeout(timer);}
 }
}
