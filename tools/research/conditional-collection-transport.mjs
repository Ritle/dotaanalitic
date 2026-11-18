/** Local HTTP integration slice. No remote transport, CLI, registration or model permission. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {sql} from '../../packages/db/dist/index.js';
import {OpenDotaClient,OpenDotaError,retryAfterMilliseconds} from '../../packages/ingestion/dist/opendota/client.js';
import {PostgresProviderBudget} from '../../packages/ingestion/dist/quota.js';
import {ConditionalCollectionJournal,CollectionCommandSchema} from './conditional-collection-journal.mjs';
import {realSha} from './conditional-real-registration.mjs';

export const collectionTransportPaths=Object.freeze([
 'tools/research/conditional-collection-transport.mjs','packages/db/migrations/065_conditional_transport_receipts.sql',
 'packages/ingestion/src/opendota/client.ts','packages/ingestion/dist/opendota/client.js',
 'packages/ingestion/src/quota.ts','packages/ingestion/dist/quota.js']);
const Id=z.string().uuid().transform(v=>v.toLowerCase()),Hash=z.string().regex(/^[a-f0-9]{64}$/);
const Options=z.object({localOrigin:z.string().url(),timeoutMs:z.number().int().min(10).max(30000).default(15000),
 maxResponseBytes:z.number().int().min(1).max(1048576).default(1048576)}).strict();
const Input=z.object({ownerId:Id,registrationId:Id,expectedHeadSha256:Hash,operationId:Id,requestId:Id,
 endpoint:z.string().regex(/^\/(?:leagues\/[1-9]\d*\/matches|matches\/[1-9]\d*|proMatches(?:\?less_than_match_id=[1-9]\d*)?)$/)}).strict();
const Result=CollectionCommandSchema.options[2].shape.result;
const Receipt=z.object({format:z.literal('conditional-local-transport-receipt-v1'),syntheticOnly:z.literal(true),
 registrationId:Id,requestId:Id,reservationHeadSha256:Hash,endpoint:Input.shape.endpoint,
 sendInvokedAt:z.string().datetime().nullable(),responseHeadersAt:z.string().datetime().nullable(),
 bodyCompletedAt:z.string().datetime().nullable(),finishedAt:z.string().datetime(),
 clockBasis:z.literal('process_wall_clock_not_historical_known_at'),httpStatus:z.number().int().min(100).max(599).nullable(),
 responseBytes:z.number().int().nonnegative(),clientValidationCode:z.string().nullable(),quotaObservationFailed:z.boolean(),
 result:Result,completionOperationId:Id}).strict();
const iso=()=>new Date().toISOString();
function fail(code){throw new Error(code);}
function origin(value){const u=new URL(value);assert(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.port&&u.port!=='0'
 &&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password,'local_loopback_origin_required');return u.origin;}

export class LocalConditionalCollectionTransport{
 constructor(db,options){this.options=Options.parse(options);this.origin=origin(this.options.localOrigin);
  this.db=db;this.journal=new ConditionalCollectionJournal(db);this.quota=new PostgresProviderBudget(db);}
 async ready(ownerId,registrationId){
  const r=await this.journal.registration(ownerId,registrationId),p=JSON.parse(r.packageText);
  for(const path of collectionTransportPaths)assert.equal(realSha(await readFile(path)),p.executable.code[path],'registered_transport_code_changed');
  const state=await this.journal.read(ownerId,registrationId);assert.equal(state.log.syntheticOnly,true,'synthetic_transport_only');return state;
 }
 async execute(raw,{signal}={}){
  const input=Input.parse(raw),{ownerId,registrationId,requestId,operationId,endpoint}=input;
  await this.ready(ownerId,registrationId);signal?.throwIfAborted();
  // Caller retries must reuse both IDs and the original parent. Never turn an old reserve into a new send.
  const begun=performance.now();
  const reserved=await this.journal.append(ownerId,registrationId,input.expectedHeadSha256,operationId,{kind:'reserve',requestId,endpoint});
  if(reserved.operationStatus!=='recorded')return {status:'already_reserved',requestId,dispatchPerformed:false,state:reserved};
  let sendInvokedAt=null,responseHeadersAt=null,bodyCompletedAt=null,httpStatus=null,responseBytes=0,rawBody=null,retryAfterAt=null;
  let localError=null,quotaObservationFailed=false,retryDelayMs=null;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.options.timeoutMs);
  const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const remaining=()=>{combined.throwIfAborted();assert(performance.now()-begun<30000,'stale_dispatch_reservation');};
  const client=new OpenDotaClient({attempts:1,maxRequests:1,timeoutMs:this.options.timeoutMs,maxWaitMs:0,maxResponseBytes:this.options.maxResponseBytes},{
   signal:combined,budget:{beforeRequest:async()=>{
    remaining();await this.quota.beforeRequest();remaining();
    const current=await this.journal.read(ownerId,registrationId);remaining();
    assert.equal(current.headSha256,reserved.headSha256,'reservation_no_longer_pending');
    const age=Date.parse(current.log.snapshotAt)-Date.parse(reserved.event.at);
    assert(age>=0&&age<30000,'stale_dispatch_reservation');
    assert(!current.report.reasons.includes('COLLECTION_WINDOW_CLOSED'),'collection_window_closed');
   },observe:async()=>{}},
   fetch:async(url,init)=>{
    remaining();assert.equal(url.origin,'https://api.opendota.com');assert.equal(url.pathname+url.search,'/api'+endpoint);
    // A literal loopback address and redirect:error prevent fixture redirects escaping to the Internet.
    sendInvokedAt=iso();
    const response=await fetch(new URL(endpoint,this.origin),{...init,signal:combined,redirect:'error'});
    responseHeadersAt=iso();httpStatus=response.status;
    const retryMs=retryAfterMilliseconds(response.headers.get('retry-after'),Date.parse(responseHeadersAt));retryDelayMs=retryMs;
    const period=p=>{const v=response.headers.get('x-rate-limit-remaining-'+p);return v!==null&&/^\d+$/.test(v)&&Number.isSafeInteger(Number(v))?Number(v):null;};
    try{await this.quota.observe(httpStatus,retryMs,{minute:period('minute'),day:period('day'),month:period('month')});}
    catch{quotaObservationFailed=true;}
    if(!response.ok){await response.body?.cancel().catch(()=>{});return new Response(null,{status:response.status,headers:response.headers});}
    const reader=response.body?.getReader(),chunks=[];
    const abort=()=>{void reader?.cancel().catch(()=>{});};combined.addEventListener('abort',abort,{once:true});
    try{
     if(reader)while(true){combined.throwIfAborted();const part=await reader.read();combined.throwIfAborted();if(part.done)break;
      responseBytes+=part.value.byteLength;if(responseBytes>this.options.maxResponseBytes){localError='source_response_too_large';fail(localError);}chunks.push(part.value);}
     const body=Buffer.concat(chunks);bodyCompletedAt=iso();
     try{rawBody=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(body);}catch{localError='source_invalid_encoding';fail(localError);}
     return new Response(body,{status:response.status,headers:response.headers});
    }finally{combined.removeEventListener('abort',abort);await reader?.cancel().catch(()=>{});reader?.releaseLock();}
   }});
  let error=null;
  try{
   if(endpoint.startsWith('/leagues/'))await client.getLeagueMatchDiscovery(endpoint.split('/')[2]);
   else if(endpoint.startsWith('/matches/'))await client.getMatchSource(endpoint.split('/')[2]);
   else await client.getProMatchDiscovery(new URL(endpoint,'http://fixture.invalid').searchParams.get('less_than_match_id')??undefined);
  }catch(e){error=e;}finally{clearTimeout(timer);}
  const code=localError??(signal?.aborted?'transport_cancelled':controller.signal.aborted?'source_timeout':
   error instanceof OpenDotaError?error.code:error?'transport_guard_failed':quotaObservationFailed?'quota_observation_failed':null);
  retryDelayMs??=error instanceof OpenDotaError?error.retryAfterMs:null;
  if(retryDelayMs!==null){
   const snapshot=await this.journal.read(ownerId,registrationId);
   // Conservatively start the full delay at persistence preparation; never shorten a provider cooldown.
   const at=Date.parse(snapshot.log.snapshotAt)+retryDelayMs;
   retryAfterAt=new Date(Math.min(at,253402300799999)).toISOString();
  }
  // Preserve complete UTF-8 2xx bodies even when JSON/schema/ID validation fails; replay marks invalid evidence.
  const result=rawBody!==null?{status:'captured',rawBody,payloadSha256:realSha(rawBody)}:
   {status:'failed',httpStatus:httpStatus!==null&&httpStatus>=400?httpStatus:null,code:code??'transport_no_body',retryAfterAt};
  const receipt=Receipt.parse({format:'conditional-local-transport-receipt-v1',syntheticOnly:true,registrationId,requestId,
   reservationHeadSha256:reserved.headSha256,endpoint,sendInvokedAt,responseHeadersAt,bodyCompletedAt,finishedAt:iso(),
   clockBasis:'process_wall_clock_not_historical_known_at',httpStatus,responseBytes,clientValidationCode:code,quotaObservationFailed,result,completionOperationId:randomUUID()});
  // A failed/uncertain commit stops here. Retry finalization, never the wire request.
  try{await this.saveReceipt(ownerId,operationId,receipt);}catch{throw new Error('transport_receipt_persistence_unknown');}
  try{return {status:'completed',requestId,dispatchPerformed:sendInvokedAt!==null,clientValidationCode:code,
   quotaObservationFailed,state:await this.finalize(ownerId,registrationId,requestId)};}
  catch{throw new Error('transport_completion_pending_receipt_saved');}
 }
 async saveReceipt(ownerId,reservationOperationId,receipt){
  const text=JSON.stringify(Receipt.parse(receipt));
  await this.db.transaction().execute(async tx=>{
   await sql`SET LOCAL synchronous_commit='on'`.execute(tx);
   assert((await sql`SELECT id FROM app_users WHERE id=${ownerId}::uuid AND is_active AND account_role='owner' FOR SHARE`.execute(tx)).rows.length,'active_owner_required');
   await sql`INSERT INTO conditional_transport_receipts(registration_id,reservation_operation_id,request_id,receipt_text)
    VALUES(${receipt.registrationId}::uuid,${reservationOperationId}::uuid,${receipt.requestId}::uuid,${text})`.execute(tx);
  });
 }
 async finalize(ownerId,registrationId,requestId){
  ownerId=Id.parse(ownerId);registrationId=Id.parse(registrationId);requestId=Id.parse(requestId);
  const current=await this.ready(ownerId,registrationId);
  const row=(await sql`SELECT * FROM conditional_transport_receipts WHERE registration_id=${registrationId}::uuid AND request_id=${requestId}::uuid`.execute(this.db)).rows[0];
  assert(row,'transport_receipt_missing');assert.equal(realSha(row.receipt_text),row.receipt_sha256,'transport_receipt_hash');
  const receipt=Receipt.parse(JSON.parse(row.receipt_text));assert.equal(receipt.registrationId,registrationId);assert.equal(receipt.requestId,requestId);
  const start=current.log.events.find(e=>e.kind==='request_started'&&e.requestId===requestId);assert.equal(start?.endpoint,receipt.endpoint,'transport_receipt_endpoint');
  const command={kind:'complete',requestId,result:receipt.result};
  // Exact append retry uses the original reservation head even when completion committed but acknowledgement was lost.
  return this.journal.append(ownerId,registrationId,receipt.reservationHeadSha256,receipt.completionOperationId,command);
 }
}
