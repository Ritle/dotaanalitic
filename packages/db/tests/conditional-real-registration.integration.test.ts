import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sql} from '../src/index.js';
import {ConditionalRealRegistrationStore} from '../../../tools/research/conditional-real-registration-store.mjs';
import {inspectRealRegistrationEnvironment,realSha,realPolicySha} from '../../../tools/research/conditional-real-registration.mjs';
import {realRegistrationFixture} from '../../../tests/fixtures/conditional-real-registration.mjs';
let database:Awaited<ReturnType<typeof testDatabase>>,store:ConditionalRealRegistrationStore,owner:string,user:string,environmentText:string;
let serverClockVerified=false;
const testAt='2026-11-15T01:00:00.000Z';
async function setFixtureClock(at:string){
 expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 // Test-only DDL in a disposable database. The application has no caller clock parameter.
 await sql`CREATE OR REPLACE FUNCTION conditional_real_registration_clock() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE
  AS ${sql.lit(`SELECT '${at}'::timestamptz`)}`.execute(database.db);
}
beforeAll(async()=>{
 database=await testDatabase();store=new ConditionalRealRegistrationStore(database.db);
 const at=(await sql<{at:Date}>`SELECT conditional_real_registration_clock() AS at`.execute(database.db)).rows[0]!.at;
 serverClockVerified=Math.abs(at.getTime()-Date.now())<2000;
 owner=(await sql<{id:string}>`INSERT INTO app_users(login,password_hash,account_role) VALUES('synthetic-real-owner',${'x'.repeat(40)},'owner') RETURNING id`.execute(database.db)).rows[0]!.id;
 user=randomUUID();
 environmentText=await inspectRealRegistrationEnvironment();
},30000);
beforeEach(async()=>{
 expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 await database.db.transaction().execute(async tx=>{
  const tables=['conditional_v2_transport_receipts','conditional_collection_v2_events','conditional_collection_v2_journals','conditional_blob_entries','conditional_blob_receipts','conditional_raw_blobs','conditional_blob_archives',
   'conditional_transport_receipts','conditional_collection_events','conditional_collection_journals','conditional_real_registration_receipts','conditional_real_registrations'];
  for(const table of tables)await sql`ALTER TABLE ${sql.id(table)} DISABLE TRIGGER USER`.execute(tx);
  await sql`TRUNCATE conditional_v2_transport_receipts,conditional_collection_v2_events,conditional_collection_v2_journals,conditional_blob_entries,conditional_blob_receipts,conditional_raw_blobs,conditional_blob_archives,
   conditional_transport_receipts,conditional_collection_events,conditional_collection_journals,conditional_real_registration_receipts,conditional_real_registrations`.execute(tx);
  await sql`DELETE FROM matches WHERE id=9999999999999`.execute(tx);
  for(const table of tables)await sql`ALTER TABLE ${sql.id(table)} ENABLE TRIGGER USER`.execute(tx);
  await sql`UPDATE app_users SET is_active=true,account_role='owner' WHERE id=${owner}::uuid`.execute(tx);
 });
 await setFixtureClock(testAt);
},30000);
afterAll(async()=>{await database?.close();},30000);
async function fixture(){const p=await realRegistrationFixture(owner);p.executable.environmentText=environmentText;p.executable.environmentSha256=realSha(environmentText);return p;}
async function register(p:Awaited<ReturnType<typeof fixture>>){const text=JSON.stringify(p);return store.register(owner,text,realSha(text));}
async function count(){return (await sql<{n:number}>`SELECT count(*)::int AS n FROM conditional_real_registrations`.execute(database.db)).rows[0]!.n;}
async function insertDirect(p:Awaited<ReturnType<typeof fixture>>,id=randomUUID()){
 const text=JSON.stringify(p);
 await sql`INSERT INTO conditional_real_registrations(id,owner_user_id,policy_sha256,package_text,package_sha256,recorded_at,writer_txid)
  VALUES(${id}::uuid,${owner}::uuid,${realPolicySha},${text},${realSha(text)},'2000-01-01','forged')`.execute(database.db);return id;
}

it('production clock uses PostgreSQL; plan receipt observes a different committed transaction and grants no scoring',async()=>{
 expect(serverClockVerified).toBe(true);const p=await fixture(),r=await register(p);
 expect(r).toMatchObject({status:'registered_plan_only',recordedAt:testAt,registeredAt:testAt,
  collectionAllowed:false,realEvaluationAllowed:false,activationAllowed:false,deployable:false});
 expect(JSON.parse(r.packageText)).toEqual(p);expect(await store.read(owner,r.id)).toEqual(r);
 const saved=(await sql<{writer_txid:string;observer_txid:string}>`SELECT r.writer_txid,c.observer_txid FROM conditional_real_registrations r
  JOIN conditional_real_registration_receipts c ON c.registration_id=r.id`.execute(database.db)).rows[0]!;
 expect(saved.writer_txid).not.toBe(saved.observer_txid);
});
it('same-package concurrent requests commit once; retries remain valid after the decision deadline',async()=>{
 const p=await fixture(),results=await Promise.all([register(p),register(p)]);
 expect(results[0]).toEqual(results[1]);expect(await count()).toBe(1);
 await setFixtureClock('2026-12-26T00:00:00.000Z');expect(await register(p)).toEqual(results[0]);
});
it('one policy cannot acquire competing first registrations with altered reviewed packages',async()=>{
 const a=await fixture(),b=structuredClone(a);b.review.reason='Another synthetic review; must not replace a registered package';
 const results=await Promise.allSettled([register(a),register(b)]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect(await count()).toBe(1);
});
it('rejects ordinary/inactive/wrong owners and private reads by another account',async()=>{
 const p=await fixture(),text=JSON.stringify(p);
 await expect(store.register(user,text,realSha(text))).rejects.toThrow('review_owner_mismatch');
 const changed=structuredClone(p);changed.review.ownerUserId=user;const userText=JSON.stringify(changed);
 await expect(store.register(user,userText,realSha(userText))).rejects.toThrow('active_owner_required');
 await sql`UPDATE app_users SET account_role='user' WHERE id=${owner}::uuid`.execute(database.db);
 await expect(register(p)).rejects.toThrow('active_owner_required');
 await sql`UPDATE app_users SET account_role='owner' WHERE id=${owner}::uuid`.execute(database.db);
 const saved=await register(p);await expect(store.read(user,saved.id)).rejects.toThrow('active_owner_required');
 await sql`UPDATE app_users SET is_active=false WHERE id=${owner}::uuid`.execute(database.db);
 await expect(register(p)).rejects.toThrow('active_owner_required');await expect(store.read(owner,saved.id)).rejects.toThrow('active_owner_required');
});
it('rejects a changed expected SHA, runtime code or environment before any registration is inserted',async()=>{
 const p=await fixture(),text=JSON.stringify(p);
 await expect(store.register(owner,text,'f'.repeat(64))).rejects.toThrow('expected_package_hash');
 p.executable.code['tools/research/conditional-real-registration.mjs']='f'.repeat(64);
 await expect(register(p)).rejects.toThrow('runtime_code_changed');expect(await count()).toBe(0);
 const env=await fixture();env.executable.environmentText='{}';env.executable.environmentSha256=realSha('{}');
 await expect(register(env)).rejects.toThrow('runtime_environment_changed');expect(await count()).toBe(0);
});
it('deadline equality and a past reviewed start bound reject registration',async()=>{
 await setFixtureClock('2026-11-19T18:00:00.000Z');await expect(register(await fixture())).rejects.toThrow('registration_deadline');
 await setFixtureClock(testAt);const p=await fixture();p.review.bindings[0].startBound.at=testAt;
 await expect(register(p)).rejects.toThrow('start_bound');expect(await count()).toBe(0);
});
it('failed first INSERT rolls back and a retry has no phantom registration',async()=>{
 const p=await fixture();await sql`ALTER TABLE conditional_real_registrations ADD CONSTRAINT synthetic_failure CHECK(false)`.execute(database.db);
 try{await expect(register(p)).rejects.toThrow();expect(await count()).toBe(0);}
 finally{await sql`ALTER TABLE conditional_real_registrations DROP CONSTRAINT synthetic_failure`.execute(database.db);}
 expect((await register(p)).status).toBe('registered_plan_only');
});
it('recovers a committed package after interruption before receipt without changing bytes or statement clock',async()=>{
 const p=await fixture(),id=await insertDirect(p),pending=await store.read(owner,id);
 expect(pending.status).toBe('commit_unconfirmed');expect(pending.recordedAt).toBe(testAt);
 const saved=await register(p);expect(saved.id).toBe(id);expect(saved.packageText).toBe(pending.packageText);expect(saved.status).toBe('registered_plan_only');
});
it('an incomplete registration cannot receive a late receipt; direct SQL cannot backdate it',async()=>{
 const p=await fixture(),id=await insertDirect(p);await setFixtureClock('2026-11-19T18:00:00.000Z');
 await expect(register(p)).rejects.toThrow('registration_deadline');
 await expect(sql`INSERT INTO conditional_real_registration_receipts(registration_id,package_sha256,observed_committed_at,observer_txid)
  VALUES(${id}::uuid,${realSha(JSON.stringify(p))},'2026-11-15','fake')`.execute(database.db)).rejects.toThrow('conditional_real_commit_not_observed_in_time');
 expect((await store.read(owner,id)).status).toBe('commit_unconfirmed');
});
it('direct SQL cannot observe its own transaction or savepoint as a committed registration',async()=>{
 const p=await fixture(),text=JSON.stringify(p),id=randomUUID();
 await expect(database.db.transaction().execute(async tx=>{
  await sql`INSERT INTO conditional_real_registrations(id,owner_user_id,policy_sha256,package_text,package_sha256,writer_txid)
   VALUES(${id}::uuid,${owner}::uuid,${realPolicySha},${text},${realSha(text)},'')`.execute(tx);
  await sql`SAVEPOINT synthetic_savepoint`.execute(tx);
  await sql`INSERT INTO conditional_real_registration_receipts(registration_id,package_sha256,observer_txid) VALUES(${id}::uuid,${realSha(text)},'')`.execute(tx);
 })).rejects.toThrow('conditional_real_commit_not_observed_in_time');expect(await count()).toBe(0);
});
it('SQL rejects forged native references, source hashes, role and budget even without the adapter',async()=>{
 const p=await fixture();p.review.bindings[0].leagueId='20359';await expect(insertDirect(p)).rejects.toThrow('conditional_real_numeric_reference_invalid');
 const b=await fixture();b.collection.maxHttpAttempts++;await expect(insertDirect(b)).rejects.toThrow('conditional_real_package_invalid');
 const source=await fixture();source.review.bindings[0].calendar.sha256='0'.repeat(64);await expect(insertDirect(source)).rejects.toThrow('conditional_real_source_invalid');
 await sql`UPDATE app_users SET is_active=false WHERE id=${owner}::uuid`.execute(database.db);
 await expect(insertDirect(await fixture())).rejects.toThrow('conditional_real_package_invalid');expect(await count()).toBe(0);
});
it('journal and receipt refuse UPDATE, DELETE and TRUNCATE CASCADE',async()=>{
 const r=await register(await fixture());
 for(const table of ['conditional_real_registrations','conditional_real_registration_receipts']){
  await expect(sql`UPDATE ${sql.id(table)} SET package_sha256=${'0'.repeat(64)}`.execute(database.db)).rejects.toThrow();
  await expect(sql`DELETE FROM ${sql.id(table)}`.execute(database.db)).rejects.toThrow();
  await expect(sql`TRUNCATE ${sql.id(table)} CASCADE`.execute(database.db)).rejects.toThrow();
 }
 expect(await store.read(owner,r.id)).toEqual(r);
});
it('read detects privileged package corruption; old synthetic journal remains empty',async()=>{
 const r=await register(await fixture());
 await database.db.transaction().execute(async tx=>{
  await sql`ALTER TABLE conditional_real_registrations DISABLE TRIGGER USER`.execute(tx);
  await sql`UPDATE conditional_real_registrations SET package_text='tampered' WHERE id=${r.id}::uuid`.execute(tx);
  await sql`ALTER TABLE conditional_real_registrations ENABLE TRIGGER USER`.execute(tx);
 });
 await expect(store.read(owner,r.id)).rejects.toThrow('stored_package_hash');
 expect((await sql<{n:number}>`SELECT count(*)::int AS n FROM conditional_registrations`.execute(database.db)).rows[0]!.n).toBe(0);
});
it('requires newly known maps in the refreshed exclusions and refuses invented extra exclusions',async()=>{
 const p=await fixture(),ids=JSON.parse(p.exposureText);ids.mapIds.push('9999999999999');const updated={...p,exposureText:JSON.stringify(ids)};
 await expect(register(updated)).rejects.toThrow('conditional_real_exposure_inventory_changed');
 await sql`INSERT INTO matches(id,started_at) VALUES(9999999999999,'2026-11-14T00:00:00Z')`.execute(database.db);
 await expect(register(p)).rejects.toThrow('conditional_real_exposure_inventory_changed');
 expect((await register(updated)).status).toBe('registered_plan_only');
});
it('does not complete a pending receipt if the inventory changed in the transaction gap',async()=>{
 const p=await fixture(),id=await insertDirect(p);
 await sql`INSERT INTO matches(id,started_at) VALUES(9999999999999,'2026-11-14T00:00:00Z')`.execute(database.db);
 await expect(register(p)).rejects.toThrow('conditional_real_exposure_inventory_changed');expect((await store.read(owner,id)).status).toBe('commit_unconfirmed');
});
it('later observations do not rewrite a completed registration or break its exact retry',async()=>{
 const p=await fixture(),r=await register(p);
 await sql`INSERT INTO matches(id,started_at) VALUES(9999999999999,'2026-11-14T00:00:00Z')`.execute(database.db);
 expect(await register(p)).toEqual(r);
});
