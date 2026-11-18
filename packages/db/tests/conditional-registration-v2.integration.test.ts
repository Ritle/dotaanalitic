import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sql} from '../dist/index.js';
import {ConditionalRegistrationV2Store} from '../../../tools/research/conditional-real-registration-v2-store.mjs';
import {ConditionalRealRegistrationStore} from '../../../tools/research/conditional-real-registration-store.mjs';
import {realSha,realPolicySha,inspectRealRegistrationEnvironment} from '../../../tools/research/conditional-real-registration.mjs';
import {registrationV2Fixture} from '../../../tests/fixtures/conditional-registration-v2.mjs';
import {realRegistrationFixture} from '../../../tests/fixtures/conditional-real-registration.mjs';
let database:Awaited<ReturnType<typeof testDatabase>>,store:ConditionalRegistrationV2Store,owner:string,other:string,environment:string;
let serverClockVerified=false;
const at='2026-11-15T01:00:00.000Z';
async function clock(value:string){expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 await sql`CREATE OR REPLACE FUNCTION conditional_real_registration_clock() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS ${sql.lit(`SELECT '${value}'::timestamptz`)}`.execute(database.db);}
beforeAll(async()=>{
 database=await testDatabase();store=new ConditionalRegistrationV2Store(database.db);
 const observed=(await sql<{at:Date}>`SELECT conditional_real_registration_clock() AS at`.execute(database.db)).rows[0]!.at;
 serverClockVerified=Math.abs(observed.getTime()-Date.now())<3000;
 owner=(await sql<{id:string}>`INSERT INTO app_users(login,password_hash,account_role) VALUES('synthetic-v2-owner',${'x'.repeat(40)},'owner') RETURNING id`.execute(database.db)).rows[0]!.id;
 other=randomUUID(); // The MVP schema permits one account total; test the ordinary role by demoting that account below.
 environment=await inspectRealRegistrationEnvironment();
},60000);
beforeEach(async()=>{
 expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 await database.db.transaction().execute(async tx=>{
  const tables=['conditional_v2_transport_receipts','conditional_collection_v2_events','conditional_collection_v2_journals','conditional_blob_entries','conditional_blob_receipts','conditional_raw_blobs','conditional_blob_archives',
   'conditional_transport_receipts','conditional_collection_events','conditional_collection_journals','conditional_real_registration_receipts','conditional_real_registrations'];
  for(const t of tables)await sql`ALTER TABLE ${sql.id(t)} DISABLE TRIGGER USER`.execute(tx);
  await sql`TRUNCATE conditional_v2_transport_receipts,conditional_collection_v2_events,conditional_collection_v2_journals,conditional_blob_entries,conditional_blob_receipts,conditional_raw_blobs,conditional_blob_archives,
   conditional_transport_receipts,conditional_collection_events,conditional_collection_journals,conditional_real_registration_receipts,conditional_real_registrations`.execute(tx);
  for(const t of tables)await sql`ALTER TABLE ${sql.id(t)} ENABLE TRIGGER USER`.execute(tx);
  await sql`DELETE FROM matches WHERE id=9999999999999`.execute(tx);
  await sql`UPDATE app_users SET is_active=true,account_role='owner' WHERE id=${owner}::uuid`.execute(tx);
 });await clock(at);
});
afterAll(async()=>{await database?.close();},30000);
async function fixture(version=2){const p=version===2?await registrationV2Fixture(owner):await realRegistrationFixture(owner);
 p.executable.environmentText=environment;p.executable.environmentSha256=realSha(environment);return p;}
async function register(p:Awaited<ReturnType<typeof fixture>>){const text=JSON.stringify(p);return store.register(owner,text,realSha(text));}
async function insert(p:Awaited<ReturnType<typeof fixture>>,executor=database.db){const id=randomUUID(),text=JSON.stringify(p);
 await sql`INSERT INTO conditional_real_registrations(id,owner_user_id,policy_sha256,package_text,package_sha256,recorded_at,writer_txid)
 VALUES(${id}::uuid,${owner}::uuid,${realPolicySha},${text},${realSha(text)},'2000-01-01','forged')`.execute(executor);return id;}
async function count(){return (await sql<{n:number}>`SELECT count(*)::int AS n FROM conditional_real_registrations`.execute(database.db)).rows[0]!.n;}
async function receipt(id:string,p:Awaited<ReturnType<typeof fixture>>,executor=database.db){await sql`INSERT INTO conditional_real_registration_receipts(registration_id,package_sha256,observed_committed_at,observer_txid)
 VALUES(${id}::uuid,${realSha(JSON.stringify(p))},'2000-01-01','forged')`.execute(executor);}

it('uses server clock and a separate committed transaction; v2 records grant no collection',async()=>{
 expect(serverClockVerified).toBe(true);const p=await fixture(),r=await register(p);
 expect(r).toMatchObject({recordedAt:at,registeredAt:at,status:'registered_plan_only',collectionAllowed:false,deployable:false});
 expect(r.packageText).toBe(JSON.stringify(p));expect(await store.read(owner,r.id)).toEqual(r);
 const row=(await sql<{writer_txid:string;observer_txid:string}>`SELECT r.writer_txid,c.observer_txid FROM conditional_real_registrations r JOIN conditional_real_registration_receipts c ON c.registration_id=r.id`.execute(database.db)).rows[0]!;
 expect(row.writer_txid).not.toBe(row.observer_txid);
 await expect(sql`INSERT INTO conditional_collection_journals(registration_id,owner_user_id,registration_sha256,synthetic_only)
  VALUES(${r.id}::uuid,${owner}::uuid,${r.packageSha256},true)`.execute(database.db)).rejects.toThrow('conditional_v2_collection_not_implemented');
},30000);
it('same package concurrent retries commit once and remain exact after deadline',async()=>{
 const p=await fixture(),r=await Promise.all([register(p),register(p)]);expect(r[0]).toEqual(r[1]);expect(await count()).toBe(1);
 await clock('2026-12-26T00:00:00.000Z');expect(await register(p)).toEqual(r[0]);
},30000);
it('rejects ordinary, inactive and other owners for registration/read',async()=>{
 const p=await fixture(),text=JSON.stringify(p);await expect(store.register(other,text,realSha(text))).rejects.toThrow('review_owner_mismatch');
 await sql`UPDATE app_users SET account_role='user' WHERE id=${owner}::uuid`.execute(database.db);await expect(register(p)).rejects.toThrow('active_owner_required');
 await sql`UPDATE app_users SET account_role='owner' WHERE id=${owner}::uuid`.execute(database.db);const r=await register(p);
 await expect(store.read(other,r.id)).rejects.toThrow('active_owner_required');
 await sql`UPDATE app_users SET is_active=false WHERE id=${owner}::uuid`.execute(database.db);await expect(register(p)).rejects.toThrow('active_owner_required');
});
it('cross-format concurrent service calls cannot register one policy twice',async()=>{
 const a=await fixture(),b=await fixture(1),text=JSON.stringify(b);
 const r=await Promise.allSettled([register(a),new ConditionalRealRegistrationStore(database.db).register(owner,text,realSha(text))]);
 expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(r.filter(x=>x.status==='rejected')).toHaveLength(1);expect(await count()).toBe(1);
},30000);
it('shared SQL unique index fences concurrent cross-format direct inserts',async()=>{
 const a=await fixture(),b=await fixture(1);
 const r=await Promise.allSettled([a,b].map(p=>database.db.transaction().execute(async tx=>{
  await sql`SELECT count(*) FROM conditional_real_registrations`.execute(tx);return insert(p,tx);
 })));
 expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(r.filter(x=>x.status==='rejected')).toHaveLength(1);expect(await count()).toBe(1);
});
it('v2 direct SQL cannot register from a stale repeatable-read exposure snapshot',async()=>{
 const p=await fixture();await expect(database.db.transaction().setIsolationLevel('repeatable read').execute(async tx=>{
  await sql`SELECT count(*) FROM matches`.execute(tx);
  await sql`INSERT INTO matches(id,started_at) VALUES(9999999999999,'2026-11-14')`.execute(database.db);
  return insert(p,tx);
 })).rejects.toThrow('conditional_v2_read_committed_required');expect(await count()).toBe(0);
});
it('v1 repeatable-read insertion still cannot duplicate an existing v2 policy',async()=>{
 await register(await fixture());const p=await fixture(1);
 await expect(database.db.transaction().setIsolationLevel('repeatable read').execute(tx=>insert(p,tx))).rejects.toThrow('duplicate key');expect(await count()).toBe(1);
});
it('v1 still registers, reads and rejects invalid v1 source after the routing migration',async()=>{
 const p=await fixture(1),old=new ConditionalRealRegistrationStore(database.db),text=JSON.stringify(p),r=await old.register(owner,text,realSha(text));
 expect(await old.read(owner,r.id)).toEqual(r);await expect(register(await fixture())).rejects.toThrow('registered_policy_package_changed');
 await expect(store.read(owner,r.id)).rejects.toThrow();
});
it('SQL chooses original validation for unknown formats and malformed v1, not v2 validation',async()=>{
 const p=await fixture(1);p.review.bindings[0].nativeReference.sha256='0'.repeat(64);await expect(insert(p)).rejects.toThrow('conditional_real_source_invalid');
 p.format='unsupported';await expect(insert(p)).rejects.toThrow('conditional_real_package_invalid');expect(await count()).toBe(0);
});
it('checks actual runtime files, required closure and environment before writing',async()=>{
 const p=await fixture();p.executable.code['tools/research/conditional-real-registration-v2.mjs']='f'.repeat(64);await expect(register(p)).rejects.toThrow('runtime_code_changed');
 const q=await fixture();delete q.executable.code['packages/db/dist/index.js'];await expect(register(q)).rejects.toThrow('runtime_manifest_incomplete');
 const r=await fixture();r.executable.environmentText='{}';r.executable.environmentSha256=realSha('{}');await expect(register(r)).rejects.toThrow('runtime_environment_changed');expect(await count()).toBe(0);
});
it('pending commit resumes; receipt cannot observe its own transaction or be backdated',async()=>{
 const p=await fixture();await expect(database.db.transaction().execute(async tx=>{const id=await insert(p,tx);await receipt(id,p,tx);})).rejects.toThrow('conditional_v2_commit_not_observed');
 expect(await count()).toBe(0);const id=await insert(p);expect((await store.read(owner,id)).status).toBe('commit_unconfirmed');
 expect((await register(p)).id).toBe(id);
});
it('deadline equality blocks new inserts and completion of an older pending record',async()=>{
 const p=await fixture(),id=await insert(p);await clock('2026-11-19T18:00:00.000Z');
 await expect(register(p)).rejects.toThrow('registration_deadline');await expect(receipt(id,p)).rejects.toThrow('conditional_v2_package_invalid');
 expect((await store.read(owner,id)).status).toBe('commit_unconfirmed');
});
it('direct SQL rejects synthetic marker, wrong budget, source hash and organizer link',async()=>{
 for(const mutate of [(p:Awaited<ReturnType<typeof fixture>>)=>p.review.syntheticOnly=true,p=>p.collection.maxHttpAttempts++,
  p=>p.review.sources[0].sha256='0'.repeat(64),p=>p.review.bindings[0].link.href='https://www.opendota.com/leagues/90002']){
  const p=await fixture();mutate(p);await expect(insert(p)).rejects.toThrow();expect(await count()).toBe(0);
 }
});
it('missing raw calendar body/hash or environment cannot slip through SQL NULL comparisons',async()=>{
 for(const kind of ['calendar','environment']){
  const p=await fixture();if(kind==='calendar'){const s=p.review.sources.find(s=>s.id==='calendar0')!;delete s.bodyText;delete s.sha256;}
  else{delete p.executable.environmentText;delete p.executable.environmentSha256;}
  await expect(insert(p)).rejects.toThrow();expect(await count()).toBe(0);
 }
});
it('required manifest hashes cannot be null in direct SQL',async()=>{
 const p=await fixture();p.executable.code['tools/research/conditional-real-registration-v2.mjs']=null;
 await expect(insert(p)).rejects.toThrow();expect(await count()).toBe(0);
});
it('calendar whitespace and a class before href preserve valid v2 binding semantics',async()=>{
 const p=await fixture(),b=p.review.bindings[0];b.calendar.editionExcerpt=' '+b.editionKey+' ';
 b.link.section=b.link.section.replace('<a href','<a class="info" href');const s=p.review.sources.find(s=>s.id===b.link.sourceId)!;
 s.bodyText='SYNTHETIC TEST ONLY '+b.link.section;s.sha256=realSha(s.bodyText);expect((await register(p)).status).toBe('registered_plan_only');
});
it('failed registration INSERT rolls back completely and a retry can succeed',async()=>{
 const p=await fixture();await sql`ALTER TABLE conditional_real_registrations ADD CONSTRAINT synthetic_v2_insert_failure CHECK(false)`.execute(database.db);
 try{await expect(register(p)).rejects.toThrow();expect(await count()).toBe(0);}
 finally{await sql`ALTER TABLE conditional_real_registrations DROP CONSTRAINT synthetic_v2_insert_failure`.execute(database.db);}
 expect((await register(p)).status).toBe('registered_plan_only');
},30000);
it('failed receipt leaves a recoverable committed plan, without a second registration',async()=>{
 const p=await fixture();await sql`ALTER TABLE conditional_real_registration_receipts ADD CONSTRAINT synthetic_v2_receipt_failure CHECK(false)`.execute(database.db);
 try{await expect(register(p)).rejects.toThrow();expect(await count()).toBe(1);}
 finally{await sql`ALTER TABLE conditional_real_registration_receipts DROP CONSTRAINT synthetic_v2_receipt_failure`.execute(database.db);}
 const row=(await sql<{id:string;recorded_at:Date}>`SELECT id,recorded_at FROM conditional_real_registrations`.execute(database.db)).rows[0]!;
 const r=await register(p);expect(r.id).toBe(row.id);expect(r.recordedAt).toBe(row.recorded_at.toISOString());expect(await count()).toBe(1);
},30000);
it('SQL validates literal href, edition/year boundaries and raw JSON duplicate keys',async()=>{
 for(const kind of ['data-href','duplicate-href','wrong-edition','duplicate-json']){
  const p=await fixture();
  if(kind==='duplicate-json'){const s=p.review.sources[0];s.bodyText='[{"leagueid":"90001","leagueid":"90002","name":"BLAST SLAM IX","tier":"professional"}]';s.sha256=realSha(s.bodyText);}
  else{const b=p.review.bindings[0],s=p.review.sources.find(s=>s.id===b.link.sourceId)!;
   b.link.section=kind==='data-href'?b.link.section.replace('href=','data-href='):kind==='wrong-edition'?b.link.section.replace('SLAM IX','SLAM IX0'):
    b.link.section.replace('href=',`href="${b.link.href}" href=`);s.bodyText=b.link.section;s.sha256=realSha(s.bodyText);}
  await expect(insert(p)).rejects.toThrow();
 }expect(await count()).toBe(0);
});
it('SQL includes changed exposure inventory at both persistence boundaries',async()=>{
 const p=await fixture(),id=await insert(p);await sql`INSERT INTO matches(id,started_at) VALUES(9999999999999,'2026-11-14')`.execute(database.db);
 await expect(register(p)).rejects.toThrow('conditional_real_exposure_inventory_changed');await expect(receipt(id,p)).rejects.toThrow('conditional_real_exposure_inventory_changed');
 expect((await store.read(owner,id)).status).toBe('commit_unconfirmed');
});
it('only a refreshed exclusion matching actual new local maps may be inserted',async()=>{
 const p=await fixture(),q=structuredClone(p),ids=JSON.parse(q.exposureText);ids.mapIds.push('9999999999999');q.exposureText=JSON.stringify(ids);
 await expect(register(q)).rejects.toThrow('conditional_real_exposure_inventory_changed');
 await sql`INSERT INTO matches(id,started_at) VALUES(9999999999999,'2026-11-14')`.execute(database.db);
 await expect(register(p)).rejects.toThrow('conditional_real_exposure_inventory_changed');expect((await register(q)).status).toBe('registered_plan_only');
});
it('immutable rows reject update/delete/truncate and detect privileged corruption',async()=>{
 const p=await fixture(),r=await register(p);
 for(const table of ['conditional_real_registrations','conditional_real_registration_receipts']){
  await expect(sql`UPDATE ${sql.id(table)} SET package_sha256=${'0'.repeat(64)}`.execute(database.db)).rejects.toThrow();
  await expect(sql`DELETE FROM ${sql.id(table)}`.execute(database.db)).rejects.toThrow();
  await expect(sql`TRUNCATE ${sql.id(table)} CASCADE`.execute(database.db)).rejects.toThrow();
 }
 await database.db.transaction().execute(async tx=>{await sql`ALTER TABLE conditional_real_registrations DISABLE TRIGGER USER`.execute(tx);
  await sql`UPDATE conditional_real_registrations SET package_text='tamper' WHERE id=${r.id}::uuid`.execute(tx);await sql`ALTER TABLE conditional_real_registrations ENABLE TRIGGER USER`.execute(tx);});
 await expect(store.read(owner,r.id)).rejects.toThrow('stored_package_hash');
});
