/** Bounded request ledger with raw-archive references. No HTTP or map enrollment. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {sql} from '../../packages/db/dist/index.js';
import {ConditionalRegistrationV2Store} from './conditional-real-registration-v2-store.mjs';
import {ConditionalBlobArchive,archiveSha as sha,archiveBody,archiveMetadata,archiveCodePaths,verifyArchiveEntry} from './conditional-blob-archive.mjs';
import {parseBindingEvidenceJson as parse} from './conditional-tournament-binding-v2.mjs';
export const collectionV2JournalPaths=['tools/research/conditional-collection-v2-journal.mjs','packages/db/migrations/068_conditional_collection_v2_journal.sql'];
const Id=z.string().uuid().transform(x=>x.toLowerCase()),Hash=z.string().regex(/^[a-f0-9]{64}$/),Time=z.string().datetime({precision:3}),iso=x=>new Date(x).toISOString();
const Endpoint=z.string().regex(/^(?:\/matches\/[1-9][0-9]{0,18}|\/leagues\/[1-9][0-9]{0,18}\/matches|\/proMatches(?:\?less_than_match_id=[1-9][0-9]{0,18})?)$/)
 .refine(x=>!x.match(/[0-9]+/)||BigInt(x.match(/[0-9]+/)[0])<=9223372036854775807n);
export const CollectionV2Command=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('reserve'),requestId:Id,endpoint:Endpoint}).strict(),
 z.object({kind:z.literal('complete'),requestId:Id}).strict(),
 z.object({kind:z.literal('fail'),requestId:Id,httpStatus:z.number().int().min(400).max(599).nullable(),
  code:z.enum(['http_error','timeout','connection_error','body_limit','incomplete_body','cancelled']),retryAfterAt:Time.nullable()}).strict(),
 z.object({kind:z.literal('recover'),requestId:Id,reason:z.string().trim().min(20).max(500)}).strict()
]).refine(c=>c.kind!=='fail'||(c.httpStatus===null)===(c.code!=='http_error'),'http_error_status_binding');
const closed={collectionAllowed:false,dispatchAllowed:false,realEvaluationAllowed:false,activationAllowed:false,deployable:false,denominatorComplete:false};
export function replayCollectionV2(registration,h,events,snapshotAt){
 Time.parse(snapshotAt);assert(h,'collection_v2_journal_required');assert(events.length<=2000,'event_limit');
 assert.equal(sha(h.header_text),h.header_sha256,'header_hash');
 assert.deepEqual(parse(h.header_text),{format:'conditional-collection-v2-journal',registrationId:registration.id,
  registrationSha256:registration.packageSha256,ownerUserId:registration.plan.ownerUserId,archiveHeaderSha256:h.archive_header_sha256,
  syntheticOnly:h.synthetic_only,createdAt:iso(h.created_at)},'header_binding');
 assert.equal(h.registration_id,registration.id);assert.equal(h.registration_sha256,registration.packageSha256);assert.equal(h.owner_user_id,registration.plan.ownerUserId);
 assert(iso(h.created_at)>=registration.registeredAt,'header_clock');Hash.parse(h.archive_header_sha256);
 let head=h.header_sha256,lastAt=iso(h.created_at),pending=null,cooldown=null,authFailed=false;
 const requests=[],ids=new Set(),operations=new Set(),daily={},plan=registration.plan;
 for(const [i,row] of events.entries()){
  assert.equal(row.registration_id,registration.id);assert.equal(row.sequence,i,'event_sequence');assert.equal(row.parent_sha256,head,'event_parent_hash');
  assert(Buffer.byteLength(row.command_text)<=8192&&Buffer.byteLength(row.event_text)<=8192,'event_limit');
  assert.equal(sha(row.command_text),row.command_sha256,'command_hash');assert(!operations.has(row.operation_id),'duplicate_operation');Id.parse(row.operation_id);operations.add(row.operation_id);
  assert.equal(sha(head+':'+row.operation_id+':'+row.command_sha256+':'+row.event_text),row.head_sha256,'event_chain_hash');
  const c=CollectionV2Command.parse(parse(row.command_text)),e=parse(row.event_text),at=iso(row.recorded_at),base={sequence:i,at,requestId:c.requestId};
  assert(at>=lastAt&&at<=snapshotAt,'event_clock');let expected;
  if(c.kind==='reserve'){
   assert(!pending,'request_in_flight');assert(!ids.has(c.requestId),'duplicate_request');
   assert(at>=plan.window.from&&at<plan.window.assessmentAt,'collection_window_closed');
   assert(!authFailed,'provider_auth_failed');assert(!cooldown||at>=cooldown,'retry_after_active');
   assert(requests.length<plan.collection.maxHttpAttempts,'total_budget_exhausted');assert((daily[at.slice(0,10)]??0)<plan.collection.maxDailyAttempts,'daily_budget_exhausted');
   const league=/^\/leagues\/(\d+)\/matches$/.exec(c.endpoint);if(league)assert(plan.scope.some(s=>s.leagueId===league[1]),'unregistered_league');
   expected={kind:'reserved',...base,endpoint:c.endpoint};pending={requestId:c.requestId,endpoint:c.endpoint,startedAt:at,status:'in_flight',finishedAt:null};
   requests.push(pending);ids.add(c.requestId);daily[at.slice(0,10)]=(daily[at.slice(0,10)]??0)+1;
  }else{
   assert(pending?.requestId===c.requestId,'no_matching_request');const request=pending;
   if(c.kind==='complete'){
    Hash.parse(e.receiptSha256);Hash.parse(e.bodySha256);Hash.parse(e.archiveEntryHeadSha256);Time.parse(e.receivedAt);
    assert(e.receivedAt>=request.startedAt&&e.receivedAt<=at,'receipt_clock');
    expected={kind:'archived',...base,receiptSha256:e.receiptSha256,bodySha256:e.bodySha256,archiveEntryHeadSha256:e.archiveEntryHeadSha256,receivedAt:e.receivedAt};
    Object.assign(request,{status:'archived',receiptSha256:e.receiptSha256,bodySha256:e.bodySha256,archiveEntryHeadSha256:e.archiveEntryHeadSha256,receivedAt:e.receivedAt});
   }else{
    if(c.kind==='recover'){
     assert(Date.parse(at)>=Date.parse(request.startedAt)+120000,'recovery_not_expired');expected={kind:'recovered_unknown',...base};request.status='outcome_unknown';
    }else{
     expected={kind:'failed',...base,httpStatus:c.httpStatus,code:c.code,retryAfterAt:c.retryAfterAt};request.status='failed';
     Object.assign(request,{httpStatus:c.httpStatus,code:c.code,retryAfterAt:c.retryAfterAt});if([401,403].includes(c.httpStatus))authFailed=true;
    }
    cooldown=[cooldown??'',c.kind==='fail'?c.retryAfterAt??'':'',new Date(Date.parse(at)+5000).toISOString()].sort().at(-1);
   }
   request.finishedAt=at;pending=null;
  }
  assert.deepEqual(e,expected,'event_command_binding');head=row.head_sha256;lastAt=at;
 }
 assert(snapshotAt>=lastAt,'snapshot_clock');const reasons=[];
 if(snapshotAt<plan.window.from)reasons.push('COLLECTION_NOT_STARTED');if(snapshotAt>=plan.window.assessmentAt)reasons.push('COLLECTION_WINDOW_CLOSED');
 if(pending)reasons.push('REQUEST_IN_FLIGHT');if(authFailed)reasons.push('PROVIDER_AUTH_FAILED');if(cooldown&&snapshotAt<cooldown)reasons.push('RETRY_AFTER');
 if(requests.length>=plan.collection.maxHttpAttempts)reasons.push('TOTAL_BUDGET_EXHAUSTED');
 if((daily[snapshotAt.slice(0,10)]??0)>=plan.collection.maxDailyAttempts)reasons.push('DAILY_BUDGET_EXHAUSTED');
 return {registrationId:registration.id,headSha256:head,sequence:events.length-1,snapshotAt,requests,pendingRequest:pending,
  attempts:{total:requests.length,byUtcDay:daily,failed:requests.filter(r=>r.status==='failed').length,unknown:requests.filter(r=>r.status==='outcome_unknown').length},
  cooldownUntil:cooldown,reasons,verifiedProMaps:null,...closed};
}
async function readHeader(tx,id){return (await sql`SELECT * FROM conditional_collection_v2_journals WHERE registration_id=${id}::uuid`.execute(tx)).rows[0];}
async function state(tx,r){const h=await readHeader(tx,r.id),rows=(await sql`SELECT * FROM conditional_collection_v2_events WHERE registration_id=${r.id}::uuid ORDER BY sequence`.execute(tx)).rows;
 const at=iso((await sql`SELECT conditional_collection_clock() AS at`.execute(tx)).rows[0].at);return {header:h,rows,report:replayCollectionV2(r,h,rows,at)};}
async function verifyArchive(tx,r,h,report){
 const a=(await sql`SELECT * FROM conditional_blob_archives WHERE registration_id=${r.id}::uuid`.execute(tx)).rows[0];assert(a,'archive_missing');
 assert.equal(sha(a.header_text),a.header_sha256,'archive_header_hash');assert.equal(a.header_sha256,h.archive_header_sha256,'archive_header_binding');
 assert.deepEqual(parse(a.header_text),{format:'conditional-blob-archive-v1',registrationId:r.id,ownerUserId:r.plan.ownerUserId,
  registrationSha256:r.packageSha256,syntheticOnly:h.synthetic_only,maxBytes:Number(a.max_bytes),maxResponses:a.max_responses,createdAt:iso(a.created_at)},'archive_header_columns');
 const entries=(await sql`SELECT * FROM conditional_blob_entries WHERE registration_id=${r.id}::uuid ORDER BY sequence`.execute(tx)).rows;
 let head=a.header_sha256;const entryByRequest=new Map();for(const [i,row] of entries.entries()){
  const e=verifyArchiveEntry(row,r.id,i,head);head=row.head_sha256;entryByRequest.set(e.requestId,{event:e,head,at:iso(row.saved_at)});}
 const requests=new Map(report.requests.map(q=>[q.requestId,q])),receipts=(await sql`SELECT * FROM conditional_blob_receipts WHERE registration_id=${r.id}::uuid ORDER BY request_id`.execute(tx)).rows;
 assert(receipts.length<=a.max_responses,'archive_receipt_limit');const found=new Set(),verified=new Map();
 for(const row of receipts){assert.equal(sha(row.metadata_text),row.receipt_sha256,'archive_receipt_hash');const m=parse(row.metadata_text),q=requests.get(row.request_id);
  assert(q&&['in_flight','archived'].includes(q.status),'archive_unreserved_receipt');
  assert.deepEqual(m,archiveMetadata(r.id,{requestId:row.request_id,endpoint:q.endpoint,httpStatus:m.httpStatus,receivedAt:m.receivedAt,clientValidationCode:m.clientValidationCode},
   {sha256:row.body_sha256,byteLength:m.responseBytes},h.synthetic_only),'archive_metadata_binding');
  assert(m.receivedAt>=q.startedAt&&m.receivedAt<=iso(row.saved_at)&&iso(row.saved_at)<=report.snapshotAt,'archive_receipt_clock');
  if(verified.has(m.bodySha256))assert.equal(verified.get(m.bodySha256),m.responseBytes,'archive_body_size');
  else{const b=(await sql`SELECT body,byte_length FROM conditional_raw_blobs WHERE registration_id=${r.id}::uuid AND body_sha256=${m.bodySha256}`.execute(tx)).rows[0];
   assert(b,'archive_body_missing');const actual=archiveBody(b.body);assert.equal(actual.sha256,m.bodySha256,'archive_body_hash');assert.equal(actual.byteLength,b.byte_length);
   assert.equal(actual.byteLength,m.responseBytes);verified.set(m.bodySha256,m.responseBytes);}
  const entry=entryByRequest.get(row.request_id);
  if(entry){assert.equal(entry.event.receiptSha256,row.receipt_sha256);assert.equal(entry.event.bodySha256,m.bodySha256);assert.equal(entry.event.responseBytes,m.responseBytes);
   assert(entry.at>=iso(row.saved_at)&&entry.at<=report.snapshotAt,'archive_entry_clock');}
  if(q.status==='archived'){assert(entry,'archive_entry_missing');assert.equal(q.receiptSha256,row.receipt_sha256);assert.equal(q.bodySha256,m.bodySha256);
   assert.equal(q.receivedAt,m.receivedAt);assert.equal(q.archiveEntryHeadSha256,entry.head);assert(q.finishedAt>=entry.at,'archive_completion_clock');}
  found.add(row.request_id);
 }
 for(const q of report.requests)if(q.status==='archived')assert(found.has(q.requestId),'archive_completed_receipt_missing');
 for(const id of entryByRequest.keys())assert(found.has(id),'archive_orphan_entry');
 const total=(await sql`SELECT count(*)::int AS n,coalesce(sum(byte_length),0)::text AS bytes FROM conditional_raw_blobs WHERE registration_id=${r.id}::uuid`.execute(tx)).rows[0];
 assert.equal(total.n,verified.size,'archive_orphan_blob');const bytes=[...verified.values()].reduce((a,b)=>a+b,0);assert.equal(Number(total.bytes),bytes);
 assert(bytes<=Number(a.max_bytes),'archive_capacity_integrity');return {verified:true,receipts:receipts.length,uniqueBytes:bytes,entries:entries.length,
  pendingReceiptRequestId:report.pendingRequest&&found.has(report.pendingRequest.requestId)?report.pendingRequest.requestId:null};
}
export class ConditionalCollectionV2Journal{
 constructor(db){this.db=db;this.registrations=new ConditionalRegistrationV2Store(db);this.archive=new ConditionalBlobArchive(db);}
 async registration(owner,id){owner=Id.parse(owner);id=Id.parse(id);const r=await this.registrations.read(owner,id);assert.equal(r.status,'registered_plan_only','registration_commit_required');
  const p=parse(r.packageText);for(const path of [...archiveCodePaths,...collectionV2JournalPaths])assert.equal(sha(await readFile(path)),p.executable.code[path],'registered_v2_journal_code_changed');return r;}
 async transaction(owner,r,fn){return this.db.transaction().setIsolationLevel('read committed').execute(async tx=>{
  await sql`SET LOCAL lock_timeout='10s'`.execute(tx);await sql`SET LOCAL synchronous_commit='on'`.execute(tx);
  await sql`SELECT conditional_blob_archive_lock(${r.id}::uuid)`.execute(tx);
  const a=(await sql`SELECT * FROM conditional_blob_archives WHERE registration_id=${r.id}::uuid`.execute(tx)).rows[0];
  assert.equal(a.owner_user_id,Id.parse(owner));assert.equal(a.registration_sha256,r.packageSha256);return fn(tx,a);
 });}
 async initialize(owner,id,expectedSha,options){const r=await this.registration(owner,id);Hash.parse(expectedSha);assert.equal(r.packageSha256,expectedSha,'expected_registration_hash');
  await this.archive.initialize(Id.parse(owner),r.id,expectedSha,options);
  return this.transaction(owner,r,async(tx,a)=>{let h=await readHeader(tx,r.id);
   if(!h)await sql`INSERT INTO conditional_collection_v2_journals(registration_id,owner_user_id,registration_sha256,archive_header_sha256,synthetic_only)
    VALUES(${r.id}::uuid,${Id.parse(owner)}::uuid,${expectedSha},${a.header_sha256},${a.synthetic_only})`.execute(tx);
   const s=await state(tx,r);return {...s.report,archive:await verifyArchive(tx,r,s.header,s.report)};
  });}
 async read(owner,id){const r=await this.registration(owner,id);return this.transaction(owner,r,async tx=>{
  const s=await state(tx,r);return {...s.report,archive:await verifyArchive(tx,r,s.header,s.report)};});}
 async append(owner,id,expectedHead,operationId,rawCommand){Hash.parse(expectedHead);operationId=Id.parse(operationId);
  const command=CollectionV2Command.parse(rawCommand),text=JSON.stringify(command),commandSha=sha(text),r=await this.registration(owner,id);
  return this.transaction(owner,r,async tx=>{const before=await state(tx,r),prior=before.rows.find(e=>e.operation_id===operationId);
   if(prior){assert.equal(prior.command_sha256,commandSha,'operation_payload_changed');assert.equal(prior.parent_sha256,expectedHead,'operation_parent_changed');
    return {...before.report,operationStatus:'already_recorded',event:parse(prior.event_text),archiveVerified:false};}
   assert.equal(before.report.headSha256,expectedHead,'collection_v2_head_conflict');
   const inserted=(await sql`INSERT INTO conditional_collection_v2_events(registration_id,sequence,operation_id,command_text,command_sha256,parent_sha256)
    VALUES(${r.id}::uuid,${before.rows.length},${operationId}::uuid,${text},${commandSha},${expectedHead}) RETURNING *`.execute(tx)).rows[0];
   const after=await state(tx,r);return {...after.report,operationStatus:'recorded',event:parse(inserted.event_text),archiveVerified:false};
  });}
}
