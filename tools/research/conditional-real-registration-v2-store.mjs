/** Internal storage only; shared SQL uniqueness fences v1 and v2, no network or collection endpoint. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sql} from '../../packages/db/dist/index.js';
import {z} from '../../packages/contracts/node_modules/zod/index.js';
import {realSha,realPolicySha} from './conditional-real-registration.mjs';
import {parseBindingEvidenceJson} from './conditional-tournament-binding-v2.mjs';
import {RegistrationV2PackageSchema,validateRegistrationV2,verifyRegistrationV2Runtime} from './conditional-real-registration-v2.mjs';
const Id=z.string().uuid(),Hash=z.string().regex(/^[a-f0-9]{64}$/),iso=x=>new Date(x).toISOString();
async function owner(tx,id){assert((await sql`SELECT id FROM app_users WHERE id=${id}::uuid AND is_active AND account_role='owner' FOR SHARE`.execute(tx)).rows[0],'active_owner_required');}
async function clock(tx){return iso((await sql`SELECT conditional_real_registration_clock() AS at`.execute(tx)).rows[0].at);}
async function row(db,id){return (await sql`SELECT r.*,c.observed_committed_at,c.observer_txid,c.package_sha256 AS receipt_sha
 FROM conditional_real_registrations r LEFT JOIN conditional_real_registration_receipts c ON c.registration_id=r.id WHERE r.id=${id}::uuid`.execute(db)).rows[0];}
function checked(r){
 assert(r,'real_registration_not_found');assert.equal(realSha(r.package_text),r.package_sha256,'stored_package_hash');
 const p=parseBindingEvidenceJson(r.package_text),plan=validateRegistrationV2(p,iso(r.recorded_at));
 assert.equal(plan.ownerUserId,r.owner_user_id,'stored_owner_changed');assert.equal(plan.policySha256,r.policy_sha256,'stored_policy_changed');
 if(r.observed_committed_at){assert.equal(r.receipt_sha,r.package_sha256,'receipt_package_changed');assert(r.writer_txid!==r.observer_txid,'commit_not_observed');
  assert(new Date(r.observed_committed_at)>=new Date(r.recorded_at),'receipt_clock_regression');validateRegistrationV2(p,iso(r.observed_committed_at));}
 return {id:r.id,packageText:r.package_text,packageSha256:r.package_sha256,plan,recordedAt:iso(r.recorded_at),
  registeredAt:r.observed_committed_at?iso(r.observed_committed_at):null,status:r.observed_committed_at?'registered_plan_only':'commit_unconfirmed',
  clockBasis:'postgres_observed_commit',collectionAllowed:false,realEvaluationAllowed:false,activationAllowed:false,deployable:false};
}
export class ConditionalRegistrationV2Store{
 constructor(db){this.db=db;}
 async register(ownerUserId,packageText,expectedSha){
  Id.parse(ownerUserId);Hash.parse(expectedSha);assert(typeof packageText==='string'&&Buffer.byteLength(packageText)<=33554432,'package_limit');
  assert.equal(realSha(packageText),expectedSha,'expected_package_hash');const p=RegistrationV2PackageSchema.parse(parseBindingEvidenceJson(packageText));
  assert.equal(p.review.reviewerUserId,ownerUserId,'review_owner_mismatch');
  const id=await this.db.transaction().setIsolationLevel('read committed').execute(async tx=>{
   await sql`SET LOCAL lock_timeout='10s'`.execute(tx);await sql`SET LOCAL synchronous_commit='on'`.execute(tx);await owner(tx,ownerUserId);
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'conditional-real:'+realPolicySha},0))`.execute(tx);
   const previous=(await sql`SELECT id,package_sha256 FROM conditional_real_registrations WHERE policy_sha256=${realPolicySha}`.execute(tx)).rows[0];
   if(previous){assert.equal(previous.package_sha256,expectedSha,'registered_policy_package_changed');return previous.id;}
   validateRegistrationV2(p,await clock(tx));await sql`SELECT check_conditional_real_exposure(${JSON.stringify(p)}::jsonb)`.execute(tx);
   await verifyRegistrationV2Runtime(p);const id=randomUUID();
   await sql`INSERT INTO conditional_real_registrations(id,owner_user_id,policy_sha256,package_text,package_sha256,writer_txid)
    VALUES(${id}::uuid,${ownerUserId}::uuid,${realPolicySha},${packageText},${expectedSha},'')`.execute(tx);return id;
  });
  await this.db.transaction().setIsolationLevel('read committed').execute(async tx=>{
   await sql`SET LOCAL lock_timeout='10s'`.execute(tx);await sql`SET LOCAL synchronous_commit='on'`.execute(tx);await owner(tx,ownerUserId);
   await sql`SELECT id FROM conditional_real_registrations WHERE id=${id}::uuid FOR UPDATE`.execute(tx);
   const saved=await row(tx,id);checked(saved);
   if(!saved.observed_committed_at){validateRegistrationV2(p,await clock(tx));await sql`SELECT check_conditional_real_exposure(${JSON.stringify(p)}::jsonb)`.execute(tx);
    await verifyRegistrationV2Runtime(p);await sql`INSERT INTO conditional_real_registration_receipts(registration_id,package_sha256,observer_txid)
     VALUES(${id}::uuid,${expectedSha},'')`.execute(tx);}
  });return this.read(ownerUserId,id);
 }
 async read(ownerUserId,id){Id.parse(ownerUserId);Id.parse(id);
  return this.db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{await owner(tx,ownerUserId);const saved=await row(tx,id);
   assert(saved?.owner_user_id===ownerUserId,'real_registration_not_found');return checked(saved);});
 }
}
