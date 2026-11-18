import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sql} from '../dist/index.js';
import {ConditionalRegistrationV2Store} from '../../../tools/research/conditional-real-registration-v2-store.mjs';
import {ConditionalBlobArchive,archiveCodePaths,archiveSha as sha} from '../../../tools/research/conditional-blob-archive.mjs';
import {ConditionalCollectionV2Journal,collectionV2JournalPaths} from '../../../tools/research/conditional-collection-v2-journal.mjs';
import {ConditionalCollectionV2Discovery,collectionV2DiscoveryPaths} from '../../../tools/research/conditional-collection-v2-discovery.mjs';
import {inspectRealRegistrationEnvironment} from '../../../tools/research/conditional-real-registration.mjs';
import {registrationV2Fixture} from '../../../tests/fixtures/conditional-registration-v2.mjs';
import {map} from '../../../tests/fixtures/conditional-registered-collector.mjs';
let database:Awaited<ReturnType<typeof testDatabase>>,owner:string,id:string,packageSha:string,journal:ConditionalCollectionV2Journal,archive:ConditionalBlobArchive;
const at='2026-12-04T00:00:00.000Z';
const tables=['conditional_v2_transport_receipts','conditional_collection_v2_events','conditional_collection_v2_journals','conditional_blob_entries','conditional_blob_receipts','conditional_raw_blobs','conditional_blob_archives'];
async function clock(value:string){expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 for(const name of ['conditional_real_registration_clock','conditional_collection_clock'])await sql`CREATE OR REPLACE FUNCTION ${sql.id(name)}() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS ${sql.lit(`SELECT '${value}'::timestamptz`)}`.execute(database.db);}
beforeAll(async()=>{
 database=await testDatabase();journal=new ConditionalCollectionV2Journal(database.db);archive=new ConditionalBlobArchive(database.db);
 owner=(await sql<{id:string}>`INSERT INTO app_users(login,password_hash,account_role) VALUES('synthetic-discovery-owner',${'x'.repeat(40)},'owner') RETURNING id`.execute(database.db)).rows[0]!.id;
 const p=await registrationV2Fixture(owner);p.executable.environmentText=await inspectRealRegistrationEnvironment();p.executable.environmentSha256=sha(p.executable.environmentText);
 for(const path of [...archiveCodePaths,...collectionV2JournalPaths,...collectionV2DiscoveryPaths])p.executable.code[path]=sha(await readFile(path));
 await clock('2026-11-15T01:00:00.000Z');const text=JSON.stringify(p),r=await new ConditionalRegistrationV2Store(database.db).register(owner,text,sha(text));id=r.id;packageSha=r.packageSha256;
},90000);
beforeEach(async()=>{
 await database.db.transaction().execute(async tx=>{for(const t of tables)await sql`ALTER TABLE ${sql.id(t)} DISABLE TRIGGER USER`.execute(tx);
  await sql`TRUNCATE conditional_v2_transport_receipts,conditional_collection_v2_events,conditional_collection_v2_journals,conditional_blob_entries,conditional_blob_receipts,conditional_raw_blobs,conditional_blob_archives`.execute(tx);
  for(const t of tables)await sql`ALTER TABLE ${sql.id(t)} ENABLE TRIGGER USER`.execute(tx);
  await sql`UPDATE app_users SET is_active=true,account_role='owner' WHERE id=${owner}::uuid`.execute(tx);
 });await clock('2026-11-15T01:02:00.000Z');await journal.initialize(owner,id,packageSha,{syntheticOnly:true,maxBytes:64*1024*1024});await clock(at);
});
afterAll(async()=>{await database?.close();},30000);
const reader=()=>new ConditionalCollectionV2Discovery(database.db);
async function reserve(endpoint:string){const state=await journal.read(owner,id),requestId=randomUUID(),operationId=randomUUID();
 const next=await journal.append(owner,id,state.headSha256,operationId,{kind:'reserve',requestId,endpoint});return {requestId,operationId,endpoint,head:next.headSha256};}
async function save(q:Awaited<ReturnType<typeof reserve>>,body:unknown){await archive.saveResponse(owner,id,q.operationId,
 {requestId:q.requestId,endpoint:q.endpoint,httpStatus:200,receivedAt:at,clientValidationCode:null},Buffer.from(typeof body==='string'?body:JSON.stringify(body)));}
async function capture(endpoint:string,body:unknown){const q=await reserve(endpoint);await save(q,body);await journal.append(owner,id,q.head,randomUUID(),{kind:'complete',requestId:q.requestId});return q;}
async function fingerprint(){const result=[];for(const table of [...tables,'provider_quotas'])result.push((await sql`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS rows FROM ${sql.id(table)} t`.execute(database.db)).rows[0]);return result;}
it('reads verified archived pages and detail projection without HTTP, quota claims or database mutations',async()=>{
 await capture('/leagues/90001/matches',[map()]);await capture('/leagues/90002/matches',[]);await capture('/matches/9007199254741201',map());
 await capture('/proMatches',[]);const before=await fingerprint(),result=await reader().read(owner,id);
 expect(result.databaseVerification.archiveVerified).toBe(true);expect(result.report.maps).toHaveLength(1);expect(result.report.maps[0].detailCaptured).toBe(true);
 expect(result.report.nextRequest).toBeNull();expect(result.report.denominatorComplete).toBe(false);expect(await fingerprint()).toEqual(before);
 expect((await reader().read(owner,id)).report).toEqual(result.report);
});
it('a saved but uncompleted response remains pending until journal completion, without fetching anything',async()=>{
 const q=await reserve('/proMatches');await save(q,[map()]);let r=await reader().read(owner,id);expect(r.report.maps).toHaveLength(0);expect(r.report.nextRequest).toBeNull();
 await journal.append(owner,id,q.head,randomUUID(),{kind:'complete',requestId:q.requestId});r=await reader().read(owner,id);expect(r.report.maps).toHaveLength(1);
});
it('invalid archived payload is visible and blocks suggested continuation without hiding its source',async()=>{
 const q=await capture('/proMatches','{invalid');const result=await reader().read(owner,id);
 expect(result.report.requests[0]).toMatchObject({requestId:q.requestId,status:'invalid_response'});expect(result.report.requests[0].bodySha256).toMatch(/^[a-f0-9]{64}$/);
 expect(result.report.nextRequest).toBeNull();expect(result.report.reasons).toContain('INVALID_DISCOVERY_RESPONSE');
});
it('does not accept unobserved detail IDs merely because the lower-level transport journal accepts them',async()=>{
 await capture('/matches/9007199254741201',map());await expect(reader().read(owner,id)).rejects.toThrow('undiscovered_detail');
});
it('rejects inactive/non-owner access and privileged changes to retained bytes',async()=>{
 await capture('/proMatches',[map()]);await expect(reader().read(randomUUID(),id)).rejects.toThrow();
 await sql`UPDATE app_users SET account_role='user' WHERE id=${owner}::uuid`.execute(database.db);await expect(reader().read(owner,id)).rejects.toThrow();
 await sql`UPDATE app_users SET account_role='owner' WHERE id=${owner}::uuid`.execute(database.db);
 await database.db.transaction().execute(async tx=>{await sql`ALTER TABLE conditional_raw_blobs DISABLE TRIGGER USER`.execute(tx);
  await sql`UPDATE conditional_raw_blobs SET body=convert_to('[]','UTF8')`.execute(tx);await sql`ALTER TABLE conditional_raw_blobs ENABLE TRIGGER USER`.execute(tx);});
 await expect(reader().read(owner,id)).rejects.toThrow('body_hash');
});
it('rejects a changed journal between full archive verification and projection instead of mixing snapshots',async()=>{
 const service=reader(),read=service.journal.read.bind(service.journal);service.journal.read=async(...args:unknown[])=>{
  const state=await read(...args);await journal.append(owner,id,state.headSha256,randomUUID(),{kind:'reserve',requestId:randomUUID(),endpoint:'/proMatches'});return state;};
 await expect(service.read(owner,id)).rejects.toThrow('snapshot_changed_retry');
});
it('detects a receipt appended during the snapshot gap even when the journal head has not changed',async()=>{
 const q=await reserve('/proMatches'),service=reader(),read=service.journal.read.bind(service.journal);service.journal.read=async(...args:unknown[])=>{
  const state=await read(...args);await save(q,[map()]);return state;};
 await expect(service.read(owner,id)).rejects.toThrow('snapshot_changed_retry');
});
it('detects a pending archive entry appended during the snapshot gap without journal completion',async()=>{
 const q=await reserve('/proMatches');await save(q,[map()]);const service=reader(),read=service.journal.read.bind(service.journal);
 service.journal.read=async(...args:unknown[])=>{const state=await read(...args);
  await archive.appendResponse(owner,id,q.requestId,(await archive.replay(owner,id)).headSha256);return state;};
 await expect(service.read(owner,id)).rejects.toThrow('snapshot_changed_retry');
});
