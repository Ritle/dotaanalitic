/** Internal evidence persistence, not a collector or an authorization to score maps. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sql} from '../../packages/db/dist/index.js';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {ConditionalRegistrationV2Store} from './conditional-real-registration-v2-store.mjs';
import {verifyRegistrationV2Runtime} from './conditional-real-registration-v2.mjs';
import {parseBindingEvidenceJson} from './conditional-tournament-binding-v2.mjs';
export const archiveCodePaths=['tools/research/conditional-blob-archive.mjs','packages/db/migrations/067_conditional_blob_archive.sql'];
export const archiveLimits=Object.freeze({bodyBytes:8388608,globalBytes:536870912,metadataBytes:16384,entryBytes:4096});
export const archiveSha=value=>createHash('sha256').update(value).digest('hex');
const Id=z.string().uuid(),Hash=z.string().regex(/^[a-f0-9]{64}$/),Time=z.string().datetime({precision:3}),iso=x=>new Date(x).toISOString();
const Endpoint=z.string().regex(/^(?:\/matches\/[1-9][0-9]{0,18}|\/leagues\/[1-9][0-9]{0,18}\/matches|\/proMatches(?:\?less_than_match_id=[1-9][0-9]{0,18})?)$/)
 .refine(x=>!x.match(/[0-9]+/)||BigInt(x.match(/[0-9]+/)[0])<=9223372036854775807n);
const Input=z.object({requestId:Id,endpoint:Endpoint,httpStatus:z.number().int().min(200).max(299),receivedAt:Time,
 clientValidationCode:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable()}).strict();
const Metadata=Input.extend({format:z.literal('conditional-blob-response-v1'),registrationId:Id,provider:z.literal('opendota'),
 knownAt:z.null(),clockBasis:z.literal('caller_observation_not_historical_known_at'),bodySha256:Hash,
 responseBytes:z.number().int().min(0).max(archiveLimits.bodyBytes),syntheticOnly:z.boolean()});
const Event=z.object({format:z.literal('conditional-blob-entry-v1'),registrationId:Id,sequence:z.number().int().min(0).max(999),requestId:Id,
 receiptSha256:Hash,bodySha256:Hash,responseBytes:z.number().int().min(0).max(archiveLimits.bodyBytes),at:Time}).strict();
const Header=z.object({format:z.literal('conditional-blob-archive-v1'),registrationId:Id,ownerUserId:Id,registrationSha256:Hash,
 syntheticOnly:z.boolean(),maxBytes:z.number().int().positive().max(archiveLimits.globalBytes),maxResponses:z.number().int().positive().max(1000),createdAt:Time}).strict();
const closed={collectionAllowed:false,realEvaluationAllowed:false,activationAllowed:false,deployable:false};
export function archiveBody(bytes){assert(Buffer.isBuffer(bytes),'archive_bytes_required');assert(bytes.length<=archiveLimits.bodyBytes,'archive_body_limit');
 return {sha256:archiveSha(bytes),byteLength:bytes.length};}
export function decodeArchiveBody(bytes){archiveBody(bytes);try{return {status:'utf8',text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)};}
 catch{return {status:'invalid_utf8',text:null};}}
export function archiveMetadata(registrationId,input,body,syntheticOnly){return Metadata.parse({format:'conditional-blob-response-v1',
 registrationId,...Input.parse(input),provider:'opendota',knownAt:null,clockBasis:'caller_observation_not_historical_known_at',
 bodySha256:body.sha256,responseBytes:body.byteLength,syntheticOnly});}
function checkedHeader(row){assert(row,'archive_not_found');assert(Buffer.byteLength(row.header_text)<=4096,'archive_header_limit');
 assert.equal(archiveSha(row.header_text),row.header_sha256,'archive_header_hash');const h=Header.parse(parseBindingEvidenceJson(row.header_text));
 assert.deepEqual(h,{format:'conditional-blob-archive-v1',registrationId:row.registration_id,ownerUserId:row.owner_user_id,
 registrationSha256:row.registration_sha256,syntheticOnly:row.synthetic_only,maxBytes:Number(row.max_bytes),maxResponses:row.max_responses,createdAt:iso(row.created_at)},'archive_header_columns');return h;}
export function verifyArchiveEntry(row,registrationId,sequence,parent){
 assert(Buffer.byteLength(row.entry_text)<=archiveLimits.entryBytes,'archive_entry_limit');
 assert.equal(row.registration_id,registrationId);assert.equal(row.sequence,sequence);assert.equal(row.parent_sha256,parent);
 assert.equal(archiveSha(parent+':'+row.entry_text),row.head_sha256,'archive_entry_hash');
 const e=Event.parse(parseBindingEvidenceJson(row.entry_text));assert.deepEqual(e,{format:'conditional-blob-entry-v1',registrationId,sequence,
 requestId:row.request_id,receiptSha256:row.receipt_sha256,bodySha256:row.body_sha256,responseBytes:row.response_bytes,at:iso(row.saved_at)},'archive_entry_columns');return e;
}
async function activeOwner(tx,owner){assert((await sql`SELECT id FROM app_users WHERE id=${owner}::uuid AND is_active AND account_role='owner' FOR SHARE`.execute(tx)).rows[0],'archive_active_owner_required');}
async function header(tx,owner,id,lock=false){
 const r=(await sql`SELECT * FROM conditional_blob_archives WHERE registration_id=${id}::uuid`.execute(tx)).rows[0];
 assert(r?.owner_user_id===owner,'archive_not_found');checkedHeader(r);
 if(lock)await sql`SELECT conditional_blob_archive_lock(${id}::uuid)`.execute(tx);return r;
}
async function capacity(tx,h){const r=(await sql`SELECT coalesce(sum(byte_length),0)::text AS global_bytes,
 coalesce(sum(byte_length) FILTER(WHERE registration_id=${h.registration_id}::uuid),0)::text AS local_bytes FROM conditional_raw_blobs`.execute(tx)).rows[0];
 const responses=Number((await sql`SELECT count(*) AS n FROM conditional_blob_receipts WHERE registration_id=${h.registration_id}::uuid`.execute(tx)).rows[0].n);
 const availableBytes=Math.min(Number(h.max_bytes)-Number(r.local_bytes),archiveLimits.globalBytes-Number(r.global_bytes));
 assert(availableBytes>=0&&responses<=h.max_responses,'archive_capacity_integrity');
 return {uniqueBytes:Number(r.local_bytes),globalUniqueBytes:Number(r.global_bytes),availableBytes,responses,
 remainingResponses:h.max_responses-responses,canFitMaximumBody:availableBytes>=archiveLimits.bodyBytes&&responses<h.max_responses,
 basis:'logical_unique_raw_bytes',reservation:false};}
async function receipt(tx,h,requestId){const r=(await sql`SELECT * FROM conditional_blob_receipts WHERE registration_id=${h.registration_id}::uuid AND request_id=${requestId}::uuid`.execute(tx)).rows[0];
 assert(r,'archive_receipt_missing');assert(Buffer.byteLength(r.metadata_text)<=archiveLimits.metadataBytes,'archive_metadata_limit');
 assert.equal(archiveSha(r.metadata_text),r.receipt_sha256,'archive_receipt_hash');const m=Metadata.parse(parseBindingEvidenceJson(r.metadata_text));
 assert.equal(m.registrationId,h.registration_id);assert.equal(m.requestId,requestId);assert.equal(m.bodySha256,r.body_sha256);assert.equal(m.syntheticOnly,h.synthetic_only);
 assert(m.receivedAt>=iso(h.created_at)&&m.receivedAt<=iso(r.saved_at),'archive_receipt_clock');return {row:r,metadata:m};}
async function body(tx,h,m){const b=(await sql`SELECT body,byte_length FROM conditional_raw_blobs WHERE registration_id=${h.registration_id}::uuid AND body_sha256=${m.bodySha256}`.execute(tx)).rows[0];
 assert(b,'archive_body_missing');const actual=archiveBody(b.body);assert.equal(actual.sha256,m.bodySha256,'archive_body_hash');
 assert.equal(actual.byteLength,b.byte_length,'archive_body_length');assert.equal(actual.byteLength,m.responseBytes,'archive_metadata_length');return b.body;}
export class ConditionalBlobArchive{
 constructor(db){this.db=db;this.registrations=new ConditionalRegistrationV2Store(db);}
 async transaction(owner,id,write,fn){Id.parse(owner);Id.parse(id);
  return this.db.transaction().setIsolationLevel(write?'read committed':'repeatable read').execute(async tx=>{
   await sql`SET LOCAL lock_timeout='10s'`.execute(tx);if(write)await sql`SET LOCAL synchronous_commit='on'`.execute(tx);
   await activeOwner(tx,owner);const h=await header(tx,owner,id,write);return fn(tx,h);
  });}
 async initialize(owner,id,expectedSha,options){Id.parse(owner);Id.parse(id);Hash.parse(expectedSha);
  const limits=z.object({syntheticOnly:z.boolean(),maxBytes:z.number().int().positive().max(archiveLimits.globalBytes),
   maxResponses:z.number().int().positive().max(1000).default(1000)}).strict().parse(options);
  const reg=await this.registrations.read(owner,id);assert.equal(reg.status,'registered_plan_only','archive_registration_uncommitted');
  assert.equal(reg.packageSha256,expectedSha,'archive_registration_hash');const p=JSON.parse(reg.packageText);
  for(const path of archiveCodePaths)assert(p.executable.code[path],'archive_code_not_registered');
  await verifyRegistrationV2Runtime(p);
  return this.db.transaction().setIsolationLevel('read committed').execute(async tx=>{
   await sql`SET LOCAL lock_timeout='10s'`.execute(tx);await sql`SET LOCAL synchronous_commit='on'`.execute(tx);await activeOwner(tx,owner);
   await sql`SELECT pg_advisory_xact_lock(hashtextextended('conditional-blob-global-capacity-v1',0))`.execute(tx);
   let h=(await sql`SELECT * FROM conditional_blob_archives WHERE registration_id=${id}::uuid`.execute(tx)).rows[0];
   if(!h)h=(await sql`INSERT INTO conditional_blob_archives(registration_id,owner_user_id,registration_sha256,synthetic_only,max_bytes,max_responses)
    VALUES(${id}::uuid,${owner}::uuid,${expectedSha},${limits.syntheticOnly},${limits.maxBytes},${limits.maxResponses}) RETURNING *`.execute(tx)).rows[0];
   const checked=checkedHeader(h);assert.equal(checked.ownerUserId,owner);assert.equal(checked.registrationSha256,expectedSha);
   assert.equal(checked.syntheticOnly,limits.syntheticOnly,'archive_options_changed');assert.equal(checked.maxBytes,limits.maxBytes,'archive_options_changed');
   assert.equal(checked.maxResponses,limits.maxResponses,'archive_options_changed');return {header:checked,headSha256:h.header_sha256,...closed};
  });
 }
 async saveResponse(owner,id,captureOperationId,input,bytes){Id.parse(captureOperationId);
  // Freeze caller-owned memory before the first await. No response body is returned or logged.
  const digest=archiveBody(bytes),retained=Buffer.from(bytes),capturedInput=Input.parse(input);
  return this.transaction(owner,id,true,async(tx,h)=>{
   const metadata=archiveMetadata(id,capturedInput,digest,h.synthetic_only),text=JSON.stringify(metadata),hash=archiveSha(text);
   const previous=(await sql`SELECT * FROM conditional_blob_receipts WHERE registration_id=${id}::uuid AND (request_id=${metadata.requestId}::uuid OR capture_operation_id=${captureOperationId}::uuid)`.execute(tx)).rows;
   if(previous.length){assert.equal(previous.length,1,'archive_capture_conflict');const r=previous[0];
    assert(r.request_id===metadata.requestId&&r.capture_operation_id===captureOperationId&&r.metadata_text===text&&r.receipt_sha256===hash,'archive_capture_conflict');
    const saved=await receipt(tx,h,metadata.requestId);await body(tx,h,saved.metadata);
    return {requestId:metadata.requestId,receiptSha256:hash,bodySha256:digest.sha256,...closed};}
   const exists=(await sql`SELECT byte_length FROM conditional_raw_blobs WHERE registration_id=${id}::uuid AND body_sha256=${digest.sha256}`.execute(tx)).rows[0];
   if(exists){assert.equal(exists.byte_length,digest.byteLength);await body(tx,h,metadata);}
   else await sql`INSERT INTO conditional_raw_blobs(registration_id,body_sha256,body,byte_length) VALUES(${id}::uuid,${digest.sha256},${retained},${digest.byteLength})`.execute(tx);
   await sql`INSERT INTO conditional_blob_receipts(registration_id,request_id,capture_operation_id,body_sha256,metadata_text)
    VALUES(${id}::uuid,${metadata.requestId}::uuid,${captureOperationId}::uuid,${digest.sha256},${text})`.execute(tx);
   return {requestId:metadata.requestId,receiptSha256:hash,bodySha256:digest.sha256,...closed};
  });
 }
 async appendResponse(owner,id,requestId,expectedHead){Id.parse(requestId);Hash.parse(expectedHead);
  return this.transaction(owner,id,true,async(tx,h)=>{
   const saved=await receipt(tx,h,requestId);await body(tx,h,saved.metadata);
   const previous=(await sql`SELECT * FROM conditional_blob_entries WHERE registration_id=${id}::uuid AND request_id=${requestId}::uuid`.execute(tx)).rows[0];
   if(previous){verifyArchiveEntry(previous,id,previous.sequence,expectedHead);assert.equal(previous.receipt_sha256,saved.row.receipt_sha256);
    return {headSha256:previous.head_sha256,sequence:previous.sequence,...closed};}
   const last=(await sql`SELECT sequence,head_sha256 FROM conditional_blob_entries WHERE registration_id=${id}::uuid ORDER BY sequence DESC LIMIT 1`.execute(tx)).rows[0];
   assert.equal(expectedHead,last?.head_sha256??h.header_sha256,'archive_head_conflict');const sequence=last?last.sequence+1:0;
   const e=(await sql`INSERT INTO conditional_blob_entries(registration_id,sequence,request_id,receipt_sha256,body_sha256,response_bytes,parent_sha256)
    VALUES(${id}::uuid,${sequence},${requestId}::uuid,${saved.row.receipt_sha256},${saved.metadata.bodySha256},${saved.metadata.responseBytes},${expectedHead}) RETURNING *`.execute(tx)).rows[0];
   verifyArchiveEntry(e,id,sequence,expectedHead);return {headSha256:e.head_sha256,sequence,...closed};
  });
 }
 async readResponse(owner,id,requestId){Id.parse(requestId);return this.transaction(owner,id,false,async(tx,h)=>{
  const saved=await receipt(tx,h,requestId);return {metadata:saved.metadata,bytes:await body(tx,h,saved.metadata),...closed};});}
 async capacity(owner,id){return this.transaction(owner,id,false,async(tx,h)=>({...await capacity(tx,h),...closed}));}
 async replay(owner,id){return this.transaction(owner,id,false,async(tx,h)=>{
  let head=h.header_sha256,sequence=0,journalBytes=Buffer.byteLength(h.header_text),lastAt=iso(h.created_at);
  const seen=new Set(),verified=new Map(),pending=[];
  async function verifyBody(m){if(verified.has(m.bodySha256))assert.equal(verified.get(m.bodySha256),m.responseBytes,'archive_metadata_length');
   else{await body(tx,h,m);verified.set(m.bodySha256,m.responseBytes);}}
  for(;;){const rows=(await sql`SELECT * FROM conditional_blob_entries WHERE registration_id=${id}::uuid AND sequence>=${sequence} ORDER BY sequence LIMIT 100`.execute(tx)).rows;
   if(!rows.length)break;
   for(const row of rows){const e=verifyArchiveEntry(row,id,sequence,head),r=await receipt(tx,h,e.requestId);
    assert.equal(e.receiptSha256,r.row.receipt_sha256);assert.equal(e.bodySha256,r.metadata.bodySha256);assert.equal(e.responseBytes,r.metadata.responseBytes);
    assert(e.at>=lastAt&&e.at>=iso(r.row.saved_at),'archive_entry_clock');assert(!seen.has(e.requestId),'archive_duplicate_request');
    await verifyBody(r.metadata);seen.add(e.requestId);head=row.head_sha256;lastAt=e.at;sequence++;journalBytes+=Buffer.byteLength(row.entry_text);
   }
  }
  let cursor=null;
  for(;;){const rows=(await sql`SELECT request_id FROM conditional_blob_receipts WHERE registration_id=${id}::uuid
    AND (${cursor}::uuid IS NULL OR request_id>${cursor}::uuid) ORDER BY request_id LIMIT 100`.execute(tx)).rows;
   if(!rows.length)break;for(const r of rows){cursor=r.request_id;if(!seen.has(cursor)){const saved=await receipt(tx,h,cursor);await verifyBody(saved.metadata);pending.push(cursor);}}
  }
  const totals=await capacity(tx,h);assert.equal(sequence+pending.length,totals.responses,'archive_response_count');
  assert.equal([...verified.values()].reduce((a,b)=>a+b,0),totals.uniqueBytes,'archive_unreferenced_bytes');
  const blobs=Number((await sql`SELECT count(*) AS n FROM conditional_raw_blobs WHERE registration_id=${id}::uuid`.execute(tx)).rows[0].n);
  assert.equal(blobs,verified.size,'archive_unreferenced_blob');
  return {status:pending.length?'pending_journal_entries':'verified_archive',headSha256:head,entries:sequence,pendingRequestIds:pending,
   uniqueBodies:verified.size,journalBytes,capacity:totals,...closed};
 });}
}
