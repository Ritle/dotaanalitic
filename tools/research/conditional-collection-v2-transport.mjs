/** One local synthetic HTTP attempt per acknowledged reservation. No remote mode. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {sql} from '../../packages/db/dist/index.js';
import {OpenDotaClient,OpenDotaError,retryAfterMilliseconds} from '../../packages/ingestion/dist/opendota/client.js';
import {PostgresProviderBudget} from '../../packages/ingestion/dist/quota.js';
import {ConditionalCollectionV2Journal,CollectionV2Command} from './conditional-collection-v2-journal.mjs';
import {archiveSha as sha,archiveBody,archiveMetadata,decodeArchiveBody} from './conditional-blob-archive.mjs';
import {parseBindingEvidenceJson as parse} from './conditional-tournament-binding-v2.mjs';
export const collectionV2TransportPaths=['tools/research/conditional-collection-v2-transport.mjs','packages/db/migrations/069_conditional_collection_v2_transport.sql',
 'packages/ingestion/src/opendota/client.ts','packages/ingestion/dist/opendota/client.js','packages/ingestion/src/quota.ts','packages/ingestion/dist/quota.js'];
const Id=z.string().uuid().transform(x=>x.toLowerCase()),Hash=z.string().regex(/^[a-f0-9]{64}$/),Time=z.string().datetime({precision:3});
const Code=z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),iso=x=>new Date(x).toISOString(),wall=()=>new Date().toISOString();
const Options=z.object({localOrigin:z.string(),timeoutMs:z.number().int().min(10).max(30000).default(15000),
 maxResponseBytes:z.number().int().min(1).max(8388608).default(8388608)}).strict();
export function localV2Origin(value){
 assert(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/.test(value),'literal_loopback_origin_required');
 const u=new URL(value);assert(Number(u.port||80)>0&&Number(u.port||80)<=65535,'loopback_port');return u.origin;
}
export function transportV2Command({requestId,hasBody,httpStatus,code,retryAfterAt}){
 if(hasBody)return CollectionV2Command.parse({kind:'complete',requestId});
 const status=httpStatus!==null&&httpStatus>=400&&httpStatus<=599?httpStatus:null;
 const normalized=status!==null?'http_error':code==='source_timeout'?'timeout':code==='source_response_too_large'?'body_limit':
  code==='source_incomplete_body'?'incomplete_body':['transport_cancelled','request_budget_exhausted','source_rate_limited','quota_claim_failed',
   'transport_guard_failed','stale_dispatch_reservation','reservation_no_longer_pending','collection_window_closed'].includes(code)?'cancelled':'connection_error';
 return CollectionV2Command.parse({kind:'fail',requestId,httpStatus:status,code:normalized,retryAfterAt});
}
const ReceiptBase=z.object({format:z.literal('conditional-local-transport-v2'),syntheticOnly:z.literal(true),registrationId:Id,requestId:Id,
 reservationOperationId:Id,reservationHeadSha256:Hash,endpoint:z.string().max(256),sendInvokedAt:Time.nullable(),responseHeadersAt:Time.nullable(),bodyCompletedAt:Time.nullable(),
 finishedAt:Time,observedAt:Time,clockBasis:z.literal('process_wall_and_postgres_observation'),httpStatus:z.number().int().min(100).max(599).nullable(),
 responseBytes:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),bodySha256:Hash.nullable(),bodyBytes:z.number().int().min(0).max(8388608).nullable(),
 clientValidationCode:Code.nullable(),quotaClaimed:z.boolean(),quotaObservationFailed:z.boolean(),quotaPeriod:z.enum(['minute','day','month','cooldown']).nullable(),
 completionOperationId:Id,command:CollectionV2Command}).strict();
export const TransportV2Receipt=ReceiptBase.superRefine((r,ctx)=>{
 const check=(ok,message)=>{if(!ok)ctx.addIssue({code:'custom',message});};
 check(CollectionV2Command.safeParse({kind:'reserve',requestId:r.requestId,endpoint:r.endpoint}).success,'endpoint');
 check(r.command.requestId===r.requestId,'request_binding');
 check((r.responseHeadersAt===null)===(r.httpStatus===null),'headers_status');
 check(r.sendInvokedAt===null||r.quotaClaimed,'send_requires_quota');check(!r.quotaClaimed||r.quotaPeriod===null,'quota_period');
 check(r.responseHeadersAt===null||r.sendInvokedAt!==null,'headers_require_send');
 const times=[r.sendInvokedAt,r.responseHeadersAt,r.bodyCompletedAt,r.finishedAt].filter(x=>x!==null);
 check(times.every((x,i)=>i===0||x>=times[i-1]),'process_clock');
 if(r.bodySha256!==null){check(r.bodyBytes!==null&&r.bodyBytes===r.responseBytes&&r.bodyCompletedAt!==null&&r.httpStatus>=200&&r.httpStatus<300,'body_binding');
  check(r.command.kind==='complete','complete_required');}
 else{check(r.bodyBytes===null&&r.bodyCompletedAt===null&&r.command.kind==='fail','failure_binding');}
 if(r.command.kind==='fail'){
  const expected=transportV2Command({requestId:r.requestId,hasBody:false,httpStatus:r.httpStatus,code:r.clientValidationCode,retryAfterAt:r.command.retryAfterAt});
  check(r.command.httpStatus===expected.httpStatus&&r.command.code===expected.code,'failure_normalization');
 }
});
const Input=z.object({ownerId:Id,registrationId:Id,expectedHeadSha256:Hash,operationId:Id,requestId:Id,endpoint:z.string().max(256)}).strict();
async function clock(db){return iso((await sql`SELECT conditional_collection_clock() AS at`.execute(db)).rows[0].at);}
function checked(row){assert(row,'v2_transport_receipt_missing');assert.equal(sha(row.receipt_text),row.receipt_sha256,'v2_transport_receipt_hash');
 const r=TransportV2Receipt.parse(parse(row.receipt_text));assert.equal(r.registrationId,row.registration_id);assert.equal(r.requestId,row.request_id);
 assert.equal(r.reservationOperationId,row.reservation_operation_id);assert.equal(r.reservationHeadSha256,row.start_head);assert.equal(r.endpoint,row.start_endpoint);
 assert(r.observedAt>=iso(row.start_at)&&r.observedAt<=iso(row.saved_at),'transport_observation_clock');return r;}
async function receipts(db,id){return (await sql`SELECT t.*,e.head_sha256 AS start_head,e.recorded_at AS start_at,e.event_text::jsonb->>'endpoint' AS start_endpoint
 FROM conditional_v2_transport_receipts t JOIN conditional_collection_v2_events e ON e.registration_id=t.registration_id AND e.operation_id=t.reservation_operation_id
 WHERE t.registration_id=${id}::uuid ORDER BY t.saved_at,t.request_id`.execute(db)).rows;}
export class LocalConditionalCollectionV2Transport{
 constructor(db,options){this.options=Options.parse(options);this.origin=localV2Origin(this.options.localOrigin);this.db=db;
  this.journal=new ConditionalCollectionV2Journal(db);this.quota=new PostgresProviderBudget(db);}
 async ready(ownerId,id){const registration=await this.journal.registration(ownerId,id),p=parse(registration.packageText);
  for(const path of collectionV2TransportPaths)assert.equal(sha(await readFile(path)),p.executable.code[path],'registered_v2_transport_code_changed');
  const state=await this.journal.read(ownerId,id),h=(await sql`SELECT synthetic_only FROM conditional_collection_v2_journals WHERE registration_id=${id}::uuid`.execute(this.db)).rows[0];
  assert.equal(h?.synthetic_only,true,'v2_synthetic_transport_only');const retained=(await receipts(this.db,id)).map(checked);return {state,retained};
 }
 async execute(raw,{signal}={}){
  const input=Input.parse(raw),{ownerId,registrationId,requestId,operationId,endpoint}=input;
  const command=CollectionV2Command.parse({kind:'reserve',requestId,endpoint}),ready=await this.ready(ownerId,registrationId);
  assert(!ready.retained.some(r=>r.quotaObservationFailed),'v2_transport_quota_reconciliation_required');signal?.throwIfAborted();
  const begun=performance.now(),reserved=await this.journal.append(ownerId,registrationId,input.expectedHeadSha256,operationId,command);
  if(reserved.operationStatus!=='recorded')return {status:'already_reserved',dispatchPerformed:false,requestId,state:reserved};
  let sendInvokedAt=null,responseHeadersAt=null,bodyCompletedAt=null,httpStatus=null,responseBytes=0,body=null,retryDelayMs=null;
  let localError=null,quotaClaimed=false,quotaPeriod=null,quotaObservationFailed=false,error=null;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.options.timeoutMs);
  const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const guard=(ok,code)=>{if(!ok){localError=code;throw new Error(code);}};
  const remaining=()=>{combined.throwIfAborted();guard(performance.now()-begun<30000,'stale_dispatch_reservation');};
  const client=new OpenDotaClient({attempts:1,maxRequests:1,timeoutMs:this.options.timeoutMs,maxWaitMs:0,maxResponseBytes:this.options.maxResponseBytes},{
   signal:combined,budget:{beforeRequest:async()=>{
    remaining();let permit;try{permit=await this.quota.claim();}catch{localError='quota_claim_failed';throw new Error(localError);}
    quotaPeriod=permit.period;
    if(!permit.allowed)throw new OpenDotaError(permit.period==='day'||permit.period==='month'?'request_budget_exhausted':'source_rate_limited',null,null,permit.retryAfterMs);
    quotaClaimed=true;remaining();const current=await this.journal.read(ownerId,registrationId);remaining();
    guard(current.headSha256===reserved.headSha256&&current.pendingRequest?.requestId===requestId,'reservation_no_longer_pending');
    const age=Date.parse(current.snapshotAt)-Date.parse(reserved.event.at);guard(age>=0&&age<30000,'stale_dispatch_reservation');
    guard(!current.reasons.includes('COLLECTION_WINDOW_CLOSED'),'collection_window_closed');
   },observe:async()=>{}},fetch:async(url,init)=>{
    remaining();guard(url.origin==='https://api.opendota.com'&&url.pathname+url.search==='/api'+endpoint,'transport_guard_failed');
    sendInvokedAt=wall();const response=await fetch(new URL(endpoint,this.origin),{...init,signal:combined,redirect:'error'});
    responseHeadersAt=wall();httpStatus=response.status;retryDelayMs=retryAfterMilliseconds(response.headers.get('retry-after'),Date.parse(responseHeadersAt));
    const period=p=>{const x=response.headers.get('x-rate-limit-remaining-'+p);return x!==null&&/^\d+$/.test(x)&&Number.isSafeInteger(Number(x))?Number(x):null;};
    try{await this.quota.observe(httpStatus,retryDelayMs,{minute:period('minute'),day:period('day'),month:period('month')});}catch{quotaObservationFailed=true;}
    if(!response.ok){await response.body?.cancel().catch(()=>{});return new Response(null,{status:response.status,headers:response.headers});}
    const reader=response.body?.getReader(),chunks=[];const abort=()=>{void reader?.cancel().catch(()=>{});};combined.addEventListener('abort',abort,{once:true});
    try{
     if(reader)while(true){combined.throwIfAborted();let part;try{part=await reader.read();}catch(e){if(!combined.aborted)localError='source_incomplete_body';throw e;}
      combined.throwIfAborted();if(part.done)break;responseBytes+=part.value.byteLength;
      guard(responseBytes<=this.options.maxResponseBytes,'source_response_too_large');chunks.push(part.value);}
     body=Buffer.concat(chunks);bodyCompletedAt=wall();if(decodeArchiveBody(body).status==='invalid_utf8')localError='source_invalid_encoding';
     return new Response([204,205].includes(response.status)?null:body,{status:response.status,headers:response.headers});
    }finally{combined.removeEventListener('abort',abort);await reader?.cancel().catch(()=>{});reader?.releaseLock();}
   }});
  try{if(endpoint.startsWith('/leagues/'))await client.getLeagueMatchDiscovery(endpoint.split('/')[2]);
   else if(endpoint.startsWith('/matches/'))await client.getMatchSource(endpoint.split('/')[2]);
   else await client.getProMatchDiscovery(new URL(endpoint,'http://fixture.invalid').searchParams.get('less_than_match_id')??undefined);
  }catch(e){error=e;}finally{clearTimeout(timer);}
  const code=localError??(signal?.aborted?'transport_cancelled':controller.signal.aborted?'source_timeout':error instanceof OpenDotaError?error.code:
   error?'transport_guard_failed':quotaObservationFailed?'quota_observation_failed':null);
  retryDelayMs??=error instanceof OpenDotaError?error.retryAfterMs:null;
  const observedAt=await clock(this.db),retryAfterAt=retryDelayMs===null?null:new Date(Math.min(Date.parse(observedAt)+retryDelayMs,253402300799999)).toISOString();
  const receipt=TransportV2Receipt.parse({format:'conditional-local-transport-v2',syntheticOnly:true,registrationId,requestId,reservationOperationId:operationId,
   reservationHeadSha256:reserved.headSha256,endpoint,sendInvokedAt,responseHeadersAt,bodyCompletedAt,finishedAt:wall(),observedAt,
   clockBasis:'process_wall_and_postgres_observation',httpStatus,responseBytes,bodySha256:body===null?null:sha(body),bodyBytes:body===null?null:body.length,
   clientValidationCode:code,quotaClaimed,quotaObservationFailed,quotaPeriod,completionOperationId:randomUUID(),
   command:transportV2Command({requestId,hasBody:body!==null,httpStatus,code,retryAfterAt})});
  try{await this.saveReceipt(ownerId,receipt,body);}catch{throw new Error('v2_transport_receipt_persistence_unknown');}
  try{return {status:'completed',requestId,dispatchPerformed:sendInvokedAt!==null,clientValidationCode:code,quotaObservationFailed,
   state:await this.finalize(ownerId,registrationId,requestId)};}catch{throw new Error('v2_transport_completion_pending_receipt_saved');}
 }
 async saveReceipt(ownerId,raw,bytes){ownerId=Id.parse(ownerId);const r=TransportV2Receipt.parse(raw),text=JSON.stringify(r),retained=bytes===null?null:Buffer.from(bytes);
  if(retained!==null){const b=archiveBody(retained);assert.equal(b.sha256,r.bodySha256);assert.equal(b.byteLength,r.bodyBytes);}else assert.equal(r.bodySha256,null);
  return this.db.transaction().setIsolationLevel('read committed').execute(async tx=>{
   await sql`SET LOCAL lock_timeout='10s'`.execute(tx);await sql`SET LOCAL synchronous_commit='on'`.execute(tx);
   await sql`SELECT conditional_blob_archive_lock(${r.registrationId}::uuid)`.execute(tx);
   const a=(await sql`SELECT owner_user_id,synthetic_only FROM conditional_blob_archives WHERE registration_id=${r.registrationId}::uuid`.execute(tx)).rows[0];
   assert.equal(a?.owner_user_id,ownerId);assert.equal(a?.synthetic_only,true,'v2_synthetic_transport_only');
   const previous=(await sql`SELECT * FROM conditional_v2_transport_receipts WHERE registration_id=${r.registrationId}::uuid AND request_id=${r.requestId}::uuid`.execute(tx)).rows[0];
   if(previous){assert.equal(previous.receipt_text,text,'v2_transport_receipt_changed');assert.equal(previous.receipt_sha256,sha(text));return;}
   if(retained!==null){
    const old=(await sql`SELECT encode(sha256(body),'hex') AS sha,octet_length(body) AS bytes,byte_length FROM conditional_raw_blobs WHERE registration_id=${r.registrationId}::uuid AND body_sha256=${r.bodySha256}`.execute(tx)).rows[0];
    if(old){assert.equal(old.sha,r.bodySha256,'archive_body_hash');assert.equal(old.bytes,r.bodyBytes);assert.equal(old.byte_length,r.bodyBytes);}
    else await sql`INSERT INTO conditional_raw_blobs(registration_id,body_sha256,body,byte_length) VALUES(${r.registrationId}::uuid,${r.bodySha256},${retained},${r.bodyBytes})`.execute(tx);
    const metadata=archiveMetadata(r.registrationId,{requestId:r.requestId,endpoint:r.endpoint,httpStatus:r.httpStatus,receivedAt:r.observedAt,clientValidationCode:r.clientValidationCode},
     {sha256:r.bodySha256,byteLength:r.bodyBytes},true);
    await sql`INSERT INTO conditional_blob_receipts(registration_id,request_id,capture_operation_id,body_sha256,metadata_text)
     VALUES(${r.registrationId}::uuid,${r.requestId}::uuid,${r.reservationOperationId}::uuid,${r.bodySha256},${JSON.stringify(metadata)})`.execute(tx);
   }
   await sql`INSERT INTO conditional_v2_transport_receipts(registration_id,request_id,reservation_operation_id,receipt_text)
    VALUES(${r.registrationId}::uuid,${r.requestId}::uuid,${r.reservationOperationId}::uuid,${text})`.execute(tx);
  });
 }
 async finalize(ownerId,registrationId,requestId){ownerId=Id.parse(ownerId);registrationId=Id.parse(registrationId);requestId=Id.parse(requestId);
  const {retained}=await this.ready(ownerId,registrationId),r=retained.find(x=>x.requestId===requestId);assert(r,'v2_transport_receipt_missing');
  return this.journal.append(ownerId,registrationId,r.reservationHeadSha256,r.completionOperationId,r.command);
 }
}
