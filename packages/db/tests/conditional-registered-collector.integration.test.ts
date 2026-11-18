import {beforeAll,afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sql} from '../src/index.js';
import {ConditionalRealRegistrationStore} from '../../../tools/research/conditional-real-registration-store.mjs';
import {ConditionalRegisteredCollector} from '../../../tools/research/conditional-registered-collector-store.mjs';
import {inspectRealRegistrationEnvironment,realSha,realPolicySha} from '../../../tools/research/conditional-real-registration.mjs';
import {collectorFixture,scan,response,map,collectionAt} from '../../../tests/fixtures/conditional-registered-collector.mjs';
let database:Awaited<ReturnType<typeof testDatabase>>,owner:string,fixture:Awaited<ReturnType<typeof collectorFixture>>,collector:ConditionalRegisteredCollector;
beforeAll(async()=>{
 database=await testDatabase();expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 owner=(await sql<{id:string}>`INSERT INTO app_users(login,password_hash,account_role) VALUES('synthetic-collector-owner',${'x'.repeat(40)},'owner') RETURNING id`.execute(database.db)).rows[0]!.id;
 await sql`CREATE OR REPLACE FUNCTION conditional_real_registration_clock() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE
  AS ${sql.lit("SELECT '2026-11-15T01:00:00.000Z'::timestamptz")}`.execute(database.db);
 fixture=await collectorFixture(owner);fixture.p.executable.environmentText=await inspectRealRegistrationEnvironment();
 fixture.p.executable.environmentSha256=realSha(fixture.p.executable.environmentText);
 const text=JSON.stringify(fixture.p),saved=await new ConditionalRealRegistrationStore(database.db).register(owner,text,realSha(text));
 fixture.log.registrationId=saved.id;fixture.log.registrationSha256=saved.packageSha256;
 scan(fixture);response(fixture,'/leagues/90001/matches',[map()]);response(fixture,'/leagues/90002/matches',[]);
 collector=new ConditionalRegisteredCollector(database.db);
},60000);
afterAll(async()=>{await database?.close();},30000);
const inspect=()=>collector.inspect(owner,fixture.log.registrationId,fixture.log.registrationSha256,fixture.log,realSha(JSON.stringify(fixture.log)));
it('reads the actual committed package as active owner and produces a bound offline report without database writes',async()=>{
 const before=(await sql`SELECT (SELECT count(*) FROM conditional_real_registrations)::int AS registrations,
  (SELECT count(*) FROM conditional_real_registration_receipts)::int AS receipts,(SELECT count(*) FROM matches)::int AS maps`.execute(database.db)).rows;
 const result=await inspect();expect(result.registrationRead.basis).toBe('active_owner_postgres_registration_read');
 expect(result.report).toMatchObject({snapshotAt:collectionAt,observedPossibleMaps:1,collectionAllowed:false,realEvaluationAllowed:false,denominatorComplete:false});
 expect(result.report.nextRequest.endpoint).toBe('/matches/9007199254741201');expect(result.persisted).toBe(false);
 const after=(await sql`SELECT (SELECT count(*) FROM conditional_real_registrations)::int AS registrations,
  (SELECT count(*) FROM conditional_real_registration_receipts)::int AS receipts,(SELECT count(*) FROM matches)::int AS maps`.execute(database.db)).rows;
 expect(after).toEqual(before);
});
it('refuses wrong owner, inactive owner, changed expected package and tampered log',async()=>{
 await expect(collector.inspect(randomUUID(),fixture.log.registrationId,fixture.log.registrationSha256,fixture.log,realSha(JSON.stringify(fixture.log)))).rejects.toThrow('active_owner_required');
 await expect(collector.inspect(owner,fixture.log.registrationId,'f'.repeat(64),fixture.log,realSha(JSON.stringify(fixture.log)))).rejects.toThrow('expected_registration_hash');
 await expect(collector.inspect(owner,fixture.log.registrationId,fixture.log.registrationSha256,fixture.log,'f'.repeat(64))).rejects.toThrow('collection_log_hash');
 await sql`UPDATE app_users SET is_active=false WHERE id=${owner}::uuid`.execute(database.db);
 try{await expect(inspect()).rejects.toThrow('active_owner_required');}finally{await sql`UPDATE app_users SET is_active=true WHERE id=${owner}::uuid`.execute(database.db);}
});
it('cannot use a registration lacking its separate commit receipt',async()=>{
 await database.db.transaction().execute(async tx=>{
  await sql`ALTER TABLE conditional_real_registration_receipts DISABLE TRIGGER USER`.execute(tx);
  await sql`DELETE FROM conditional_real_registration_receipts`.execute(tx);
  await sql`ALTER TABLE conditional_real_registration_receipts ENABLE TRIGGER USER`.execute(tx);
 });
 await expect(inspect()).rejects.toThrow();
 const text=JSON.stringify(fixture.p);await new ConditionalRealRegistrationStore(database.db).register(owner,text,realSha(text));
 expect((await inspect()).registrationRead.registeredAt).not.toBeNull();
});
it('requires the collector code actually frozen with the package, not a caller supplied readiness flag',async()=>{
 const changed=structuredClone(fixture.p);changed.executable.code['tools/research/conditional-registered-collector.mjs']='0'.repeat(64);
 const text=JSON.stringify(changed),sha=realSha(text);
 // Test-only privileged corruption in a disposable database, not an application update path.
 await database.db.transaction().execute(async tx=>{
  await sql`ALTER TABLE conditional_real_registrations DISABLE TRIGGER USER`.execute(tx);
  await sql`ALTER TABLE conditional_real_registration_receipts DISABLE TRIGGER USER`.execute(tx);
  await sql`UPDATE conditional_real_registrations SET package_text=${text},package_sha256=${sha} WHERE policy_sha256=${realPolicySha}`.execute(tx);
  await sql`UPDATE conditional_real_registration_receipts SET package_sha256=${sha}`.execute(tx);
  await sql`ALTER TABLE conditional_real_registration_receipts ENABLE TRIGGER USER`.execute(tx);
  await sql`ALTER TABLE conditional_real_registrations ENABLE TRIGGER USER`.execute(tx);
 });
 const log={...fixture.log,registrationSha256:sha};
 await expect(collector.inspect(owner,log.registrationId,sha,log,realSha(JSON.stringify(log)))).rejects.toThrow('registered_collector_code_changed');
});
