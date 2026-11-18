/** Durable collection bookkeeping only. No provider transport or model authorization. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {sql} from '../../packages/db/dist/index.js';
import {ConditionalRealRegistrationStore} from './conditional-real-registration-store.mjs';
import {realSha} from './conditional-real-registration.mjs';
import {RegisteredCollectionLogSchema,replayRegisteredCollection,registeredCollectorPaths} from './conditional-registered-collector.mjs';
export const collectionJournalPaths=Object.freeze(['tools/research/conditional-collection-journal.mjs','packages/db/migrations/064_conditional_collection_journal.sql']);
const Id=z.string().uuid().transform(v=>v.toLowerCase()),Hash=z.string().regex(/^[a-f0-9]{64}$/),iso=v=>new Date(v).toISOString();
const Result=RegisteredCollectionLogSchema.shape.events.element.options[2].shape.result;
export const CollectionCommandSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('scan'),scanId:Id}).strict(),
 z.object({kind:z.literal('reserve'),requestId:Id,endpoint:z.string().min(1).max(256)}).strict(),
 z.object({kind:z.literal('complete'),requestId:Id,result:Result}).strict(),
 z.object({kind:z.literal('recover'),requestId:Id,reason:z.string().trim().min(20).max(2000)}).strict()]);
async function owner(tx,id){assert((await sql`SELECT id FROM app_users WHERE id=${id}::uuid AND is_active AND account_role='owner' FOR SHARE`.execute(tx)).rows.length,'active_owner_required');}
async function now(tx){return iso((await sql`SELECT conditional_collection_clock() AS at`.execute(tx)).rows[0].at);}
async function rows(tx,id){return (await sql`SELECT * FROM conditional_collection_events WHERE registration_id=${id}::uuid ORDER BY sequence`.execute(tx)).rows;}
async function header(tx,id){return (await sql`SELECT * FROM conditional_collection_journals WHERE registration_id=${id}::uuid`.execute(tx)).rows[0];}
function eventFor(command,sequence,at){
 if(command.kind==='scan')return {kind:'scan_started',sequence,at,scanId:command.scanId};
 if(command.kind==='reserve')return {kind:'request_started',sequence,at,requestId:command.requestId,endpoint:command.endpoint};
 return {kind:'request_finished',sequence,at,requestId:command.requestId,result:command.kind==='recover'?
  {status:'failed',httpStatus:null,code:'recovery_outcome_unknown',retryAfterAt:null}:command.result};
}
const equal=(a,b)=>assert.deepEqual(a,b,'stored_event_command_mismatch');
export function replayCollectionJournal(registration,h,events,snapshotAt){
 assert(h,'collection_journal_not_found');assert.equal(realSha(h.header_text),h.header_sha256,'header_hash');
 const declared=JSON.parse(h.header_text);equal(declared,{format:'conditional-collection-journal-v1',registrationId:registration.id,
  registrationSha256:registration.packageSha256,ownerUserId:registration.plan.ownerUserId,syntheticOnly:h.synthetic_only,createdAt:iso(h.created_at)});
 assert.equal(h.registration_id,registration.id,'journal_registration_changed');assert.equal(h.registration_sha256,registration.packageSha256,'journal_package_changed');
 assert.equal(h.owner_user_id,registration.plan.ownerUserId,'journal_owner_changed');assert(iso(h.created_at)>=registration.registeredAt,'header_before_registration');
 let head=h.header_sha256,lastAt=iso(h.created_at);const logEvents=[],operations=new Set();
 for(const [i,row] of events.entries()){
  assert.equal(row.registration_id,registration.id,'event_registration_changed');assert.equal(row.sequence,i,'event_sequence_gap');
  assert(!operations.has(row.operation_id),'duplicate_operation');operations.add(row.operation_id);Id.parse(row.operation_id);
  assert.equal(realSha(row.command_text),row.command_sha256,'command_hash');assert.equal(row.parent_sha256,head,'event_parent_hash');
  assert.equal(realSha(head+':'+row.operation_id+':'+row.command_sha256+':'+row.event_text),row.head_sha256,'event_chain_hash');
  const command=CollectionCommandSchema.parse(JSON.parse(row.command_text)),event=JSON.parse(row.event_text),at=iso(row.recorded_at);
  equal(event,eventFor(command,i,at));assert(at>=lastAt&&at<=snapshotAt,'event_clock_regression');lastAt=at;
  if(command.kind==='recover'){
   const start=logEvents.find(e=>e.kind==='request_started'&&e.requestId===command.requestId);
   assert(start&&Date.parse(at)>=Date.parse(start.at)+120000,'recovery_not_expired');
  }
  head=row.head_sha256;logEvents.push(event);
 }
 assert(snapshotAt>=lastAt,'snapshot_clock_regression');
 const log={format:'conditional-registered-collection-v1',registrationId:registration.id,registrationSha256:registration.packageSha256,
  syntheticOnly:h.synthetic_only,snapshotAt,events:logEvents},logSha256=realSha(JSON.stringify(log));
 const report=replayRegisteredCollection(registration,log,logSha256);
 return {registrationId:registration.id,headSha256:head,sequence:events.length-1,log,logSha256,report,
  persisted:true,clockBasis:'postgres',collectionAllowed:false,dispatchAllowed:false,realEvaluationAllowed:false,activationAllowed:false,deployable:false};
}
export class ConditionalCollectionJournal{
 constructor(db){this.db=db;this.registrations=new ConditionalRealRegistrationStore(db);}
 async registration(ownerId,id){
  Id.parse(ownerId);Id.parse(id);const r=await this.registrations.read(ownerId,id);assert.equal(r.status,'registered_plan_only','registration_commit_required');
  const p=JSON.parse(r.packageText);for(const path of [...registeredCollectorPaths,...collectionJournalPaths])
   assert.equal(realSha(await readFile(path)),p.executable.code[path],'registered_journal_code_changed');
  return r;
 }
 async transaction(ownerId,r,fn){
  return this.db.transaction().execute(async tx=>{
   await sql`SET LOCAL lock_timeout='10s'`.execute(tx);await sql`SET LOCAL synchronous_commit='on'`.execute(tx);
   await owner(tx,ownerId);await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'conditional-collection:'+r.id},0))`.execute(tx);
   const saved=(await sql`SELECT r.package_sha256 FROM conditional_real_registrations r JOIN conditional_real_registration_receipts c ON c.registration_id=r.id
    WHERE r.id=${r.id}::uuid AND r.owner_user_id=${ownerId}::uuid AND r.package_sha256=c.package_sha256`.execute(tx)).rows[0];
   assert.equal(saved?.package_sha256,r.packageSha256,'registration_changed');return fn(tx);
  });
 }
 async initialize(ownerId,id,expectedPackageSha,options){
  Hash.parse(expectedPackageSha);const {syntheticOnly}=z.object({syntheticOnly:z.boolean()}).strict().parse(options);
  const r=await this.registration(ownerId,id);assert.equal(r.packageSha256,expectedPackageSha,'expected_registration_hash');
  return this.transaction(ownerId,r,async tx=>{
   const h=await header(tx,id);
   if(h){assert.equal(h.synthetic_only,syntheticOnly,'journal_origin_changed');}
   else await sql`INSERT INTO conditional_collection_journals(registration_id,owner_user_id,registration_sha256,synthetic_only)
    VALUES(${id}::uuid,${ownerId}::uuid,${expectedPackageSha},${syntheticOnly})`.execute(tx);
   return replayCollectionJournal(r,await header(tx,id),await rows(tx,id),await now(tx));
  });
 }
 async read(ownerId,id){
  const r=await this.registration(ownerId,id);
  return this.transaction(ownerId,r,async tx=>replayCollectionJournal(r,await header(tx,id),await rows(tx,id),await now(tx)));
 }
 async append(ownerId,id,expectedHeadSha,operationId,rawCommand){
  Hash.parse(expectedHeadSha);operationId=Id.parse(operationId);const command=CollectionCommandSchema.parse(rawCommand),text=JSON.stringify(command),commandSha=realSha(text);
  const r=await this.registration(ownerId,id);
  return this.transaction(ownerId,r,async tx=>{
   const h=await header(tx,id),events=await rows(tx,id),snapshot=await now(tx),before=replayCollectionJournal(r,h,events,snapshot);
   const old=events.find(e=>e.operation_id===operationId);
   if(old){
    assert.equal(old.command_sha256,commandSha,'operation_payload_changed');assert.equal(old.parent_sha256,expectedHeadSha,'operation_parent_changed');
    return {...before,operationStatus:'already_recorded',operationId,event:JSON.parse(old.event_text)};
   }
   assert.equal(before.headSha256,expectedHeadSha,'journal_head_conflict');
   if(command.kind==='recover'){
    const pending=before.report.requests.find(q=>q.requestId===command.requestId&&q.status==='in_flight');
    assert(pending,'no_matching_inflight_request');assert(Date.parse(snapshot)>=Date.parse(pending.startedAt)+120000,'recovery_not_expired');
   }
   // Validate once before INSERT; SQL supplies its own final clock, then replay again before COMMIT.
   const preview={...before.log,events:[...before.log.events,eventFor(command,events.length,snapshot)]};
   replayRegisteredCollection(r,preview,realSha(JSON.stringify(preview)));
   await sql`INSERT INTO conditional_collection_events(registration_id,sequence,operation_id,command_text,command_sha256,parent_sha256)
    VALUES(${id}::uuid,${events.length},${operationId}::uuid,${text},${commandSha},${expectedHeadSha})`.execute(tx);
   const stored=await rows(tx,id),after=replayCollectionJournal(r,h,stored,await now(tx));
   return {...after,operationStatus:'recorded',operationId,event:JSON.parse(stored.at(-1).event_text)};
  });
 }
}
