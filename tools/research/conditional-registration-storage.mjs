/** PostgreSQL transport for the synthetic registration contract; no real evaluation authorization.
 * Keep the frozen evaluator and its code hashes untouched. A future verified-source adapter is
 * required before any real registration, collection or scoring can use this storage boundary.
 */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {sql} from '../../packages/db/dist/index.js';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {RegistrationPlanSchema,AssessmentBindingSchema,prepareRegistration,bindAssessment,registrationDigest} from './conditional-registration.mjs';

const Hash=z.string().regex(/^[a-f0-9]{64}$/),Id=z.string().uuid(),Text=z.string().max(16777216);
const Request=z.object({registrationId:Id,expectedHead:Hash.nullable(),execution:AssessmentBindingSchema,
 reportText:Text,correctionReason:z.string().trim().min(10).max(1000).nullable()}).strict();
const sha=text=>createHash('sha256').update(text).digest('hex');
const bytes=value=>JSON.stringify(value);
const limit=text=>assert(Buffer.byteLength(text)<=16777216,'conditional_storage_size_limit');
const iso=date=>new Date(date).toISOString();
const now=async tx=>(await sql`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`.execute(tx)).rows[0].now.toISOString();
const same=(a,b,why)=>assert.equal(registrationDigest(a),registrationDigest(b),why);

function checkedRegistration(row){
 assert(row,'conditional_registration_not_found');
 limit(row.plan_text);
 assert.equal(sha(row.plan_text),row.plan_sha256,'conditional_stored_plan_hash');
 const plan=RegistrationPlanSchema.parse(JSON.parse(row.plan_text));
 prepareRegistration(plan,iso(row.recorded_at));
 if(row.observed_committed_at){
  assert.equal(row.receipt_plan_sha256,row.plan_sha256,'conditional_receipt_plan_changed');
  assert(row.observer_txid!==row.writer_txid,'conditional_commit_not_observed');
  assert(new Date(row.observed_committed_at)>=new Date(row.recorded_at),'conditional_receipt_clock_regression');
  prepareRegistration(plan,iso(row.observed_committed_at));
 }
 return {id:row.id,plan,planText:row.plan_text,planSha256:row.plan_sha256,recordedAt:iso(row.recorded_at),
  registeredAt:row.observed_committed_at?iso(row.observed_committed_at):null,
  clockBasis:'postgres_observed_commit',status:row.observed_committed_at?'stored_synthetic_only':'commit_unconfirmed',
  realRegistration:false,realEvaluationAllowed:false,collectionAllowed:false,deployable:false};
}

async function registrationRow(db,id){
 return (await sql`SELECT r.*,c.observed_committed_at,c.observer_txid,c.plan_sha256 AS receipt_plan_sha256 FROM conditional_registrations r
  LEFT JOIN conditional_registration_receipts c ON c.registration_id=r.id WHERE r.id=${id}::uuid`.execute(db)).rows[0];
}
function checkedChain(registration,rows){
 assert(registration.registeredAt,'conditional_commit_unconfirmed');
 const contract=prepareRegistration(registration.plan,registration.registeredAt);
 let previous=null,head=null;const reports=new Set(),manifests=new Set(),result=[];
 for(const row of rows){
  limit(row.execution_text);limit(row.report_text);
  assert.equal(row.registration_id,registration.id,'conditional_foreign_assessment');
  assert.equal(sha(row.execution_text),row.execution_sha256,'conditional_stored_execution_hash');
  assert.equal(sha(row.report_text),row.report_sha256,'conditional_stored_report_hash');
  const execution=AssessmentBindingSchema.parse(JSON.parse(row.execution_text));
  assert.equal(execution.reportSha256,row.report_sha256,'conditional_report_binding');
  assert.equal(execution.manifestSha256,row.manifest_sha256,'conditional_manifest_binding');
  assert(!reports.has(row.report_sha256)&&!manifests.has(row.manifest_sha256),'conditional_reused_result');
  assert.equal(row.parent_execution_sha256,head,'conditional_chain_parent');
  previous=bindAssessment(contract,execution,previous,row.correction_reason,iso(row.recorded_at));
  assert.equal(previous.revision,row.revision,'conditional_chain_revision');
  head=row.execution_sha256; reports.add(row.report_sha256);manifests.add(row.manifest_sha256);
  result.push({revision:row.revision,parentSha256:row.parent_execution_sha256,sha256:head,execution,
   executionText:row.execution_text,reportText:row.report_text,correctionReason:row.correction_reason,recordedAt:iso(row.recorded_at),
   clockBasis:'postgres_statement_clock',realEvaluationAllowed:false,deployable:false});
 }
 return {result,previous,contract,head};
}
async function chainRows(db,id){
 const rows=(await sql`SELECT * FROM conditional_assessments WHERE registration_id=${id}::uuid ORDER BY revision LIMIT 1001`.execute(db)).rows;
 assert(rows.length<=1000,'conditional_chain_limit');return rows;
}

export class ConditionalRegistrationStorage {
 constructor(db){this.db=db;}

 /** No clock argument. The receipt is deliberately a separate top-level transaction. */
 async register(raw){
  const plan=RegistrationPlanSchema.parse(raw),planText=bytes(plan);limit(planText);const planSha=sha(planText);
  const id=await this.db.transaction().execute(async tx=>{
   await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'conditional-plan:'+planSha},0))`.execute(tx);
   const existing=(await sql`SELECT id FROM conditional_registrations WHERE plan_sha256=${planSha}`.execute(tx)).rows[0];
   if(existing)return existing.id;
   prepareRegistration(plan,await now(tx));
   const id=randomUUID();
   await sql`INSERT INTO conditional_registrations(id,plan_text,plan_sha256,protocol_key,writer_txid)
    VALUES(${id}::uuid,${planText},${planSha},'', '')`.execute(tx);
   return id;
  });
  // An interrupted registration can resume this observation; an expired one remains unusable.
  await this.db.transaction().execute(async tx=>{
   await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
   await sql`SELECT id FROM conditional_registrations WHERE id=${id}::uuid FOR UPDATE`.execute(tx);
   const receipt=(await sql`SELECT registration_id FROM conditional_registration_receipts WHERE registration_id=${id}::uuid`.execute(tx)).rows[0];
   if(!receipt)await sql`INSERT INTO conditional_registration_receipts(registration_id,plan_sha256,observer_txid)
    VALUES(${id}::uuid,${planSha},'')`.execute(tx);
  });
  return this.readRegistration(id);
 }

 async readRegistration(id){Id.parse(id);return checkedRegistration(await registrationRow(this.db,id));}

 async read(id){
  Id.parse(id);
  return this.db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
   const registration=checkedRegistration(await registrationRow(tx,id));
   if(!registration.registeredAt)return {registration,assessments:[],head:null};
   const chain=checkedChain(registration,await chainRows(tx,id));
   return {registration,assessments:chain.result,head:chain.head};
  });
 }

 /** The caller supplies already verified execution/report bytes, never a scorer or a clock.
  * This storage validates binding, not source truth or numeric evaluation. There is no CLI/API.
  */
 async append(raw){
  const request=Request.parse(raw),executionText=bytes(request.execution);limit(executionText);limit(request.reportText);
  assert.equal(sha(request.reportText),request.execution.reportSha256,'conditional_report_hash');
  const executionSha=sha(executionText);
  return this.db.transaction().execute(async tx=>{
   await sql`SET LOCAL lock_timeout='10s'`.execute(tx);
   await sql`SELECT id FROM conditional_registrations WHERE id=${request.registrationId}::uuid FOR UPDATE`.execute(tx);
   const registration=checkedRegistration(await registrationRow(tx,request.registrationId));
   const rows=await chainRows(tx,request.registrationId),chain=checkedChain(registration,rows);
   const existing=chain.result.find(row=>row.sha256===executionSha);
   if(existing){
    assert.equal(existing.parentSha256,request.expectedHead,'conditional_retry_parent_changed');
    assert.equal(existing.correctionReason,request.correctionReason,'conditional_retry_reason_changed');
    assert.equal(existing.reportText,request.reportText,'conditional_retry_report_changed');
    same(existing.execution,request.execution,'conditional_retry_execution_changed');
    return {status:'already_recorded',assessment:existing};
   }
   assert.equal(request.expectedHead,chain.head,'conditional_parent_changed');
   assert(rows.length<1000,'conditional_chain_limit');
   assert(!rows.some(r=>r.report_sha256===request.execution.reportSha256||r.manifest_sha256===request.execution.manifestSha256),'conditional_reused_result');
   bindAssessment(chain.contract,request.execution,chain.previous,request.correctionReason,await now(tx));
   await sql`INSERT INTO conditional_assessments(registration_id,revision,parent_execution_sha256,correction_reason,
    execution_text,execution_sha256,report_text,report_sha256,manifest_sha256)
    VALUES(${request.registrationId}::uuid,${rows.length+1},${request.expectedHead},${request.correctionReason},
     ${executionText},${executionSha},${request.reportText},${request.execution.reportSha256},${request.execution.manifestSha256})`.execute(tx);
   const saved=checkedChain(registration,await chainRows(tx,request.registrationId));
   return {status:'recorded',assessment:saved.result.at(-1)};
  });
 }
}
