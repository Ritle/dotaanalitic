import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sql} from '../dist/index.js';
import {ConditionalRegistrationV2Store} from '../../../tools/research/conditional-real-registration-v2-store.mjs';
import {ConditionalBlobArchive,archiveBody,archiveMetadata,archiveSha,archiveCodePaths} from '../../../tools/research/conditional-blob-archive.mjs';
import {inspectRealRegistrationEnvironment} from '../../../tools/research/conditional-real-registration.mjs';
import {registrationV2Fixture} from '../../../tests/fixtures/conditional-registration-v2.mjs';
let database:Awaited<ReturnType<typeof testDatabase>>,archive:ConditionalBlobArchive,owner:string,reg:{id:string;packageSha256:string};
const tables=['conditional_v2_transport_receipts','conditional_collection_v2_events','conditional_collection_v2_journals','conditional_blob_entries','conditional_blob_receipts','conditional_raw_blobs','conditional_blob_archives'];
const at='2026-11-15T01:02:00.000Z';
async function clock(value:string){expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 await sql`CREATE OR REPLACE FUNCTION conditional_real_registration_clock() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS ${sql.lit(`SELECT '${value}'::timestamptz`)}`.execute(database.db);}
beforeAll(async()=>{
 database=await testDatabase();archive=new ConditionalBlobArchive(database.db);
 owner=(await sql<{id:string}>`INSERT INTO app_users(login,password_hash,account_role) VALUES('synthetic-archive-owner',${'x'.repeat(40)},'owner') RETURNING id`.execute(database.db)).rows[0]!.id;
 const p=await registrationV2Fixture(owner);p.executable.environmentText=await inspectRealRegistrationEnvironment();p.executable.environmentSha256=archiveSha(p.executable.environmentText);
 for(const path of archiveCodePaths)p.executable.code[path]=archiveSha(await readFile(path));
 await clock('2026-11-15T01:00:00.000Z');const text=JSON.stringify(p);
 reg=await new ConditionalRegistrationV2Store(database.db).register(owner,text,archiveSha(text));
},90000);
beforeEach(async()=>{
 expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 await database.db.transaction().execute(async tx=>{
  for(const t of tables)await sql`ALTER TABLE ${sql.id(t)} DISABLE TRIGGER USER`.execute(tx);
  await sql`TRUNCATE conditional_v2_transport_receipts,conditional_collection_v2_events,conditional_collection_v2_journals,conditional_blob_entries,conditional_blob_receipts,conditional_raw_blobs,conditional_blob_archives`.execute(tx);
  for(const t of tables)await sql`ALTER TABLE ${sql.id(t)} ENABLE TRIGGER USER`.execute(tx);
  await sql`UPDATE app_users SET is_active=true,account_role='owner' WHERE id=${owner}::uuid`.execute(tx);
 });await clock(at);
});
afterAll(async()=>{await database?.close();},30000);
const init=(maxBytes=1024,maxResponses=1000)=>archive.initialize(owner,reg.id,reg.packageSha256,{syntheticOnly:true,maxBytes,maxResponses});
const input=(requestId=randomUUID())=>({requestId,endpoint:'/matches/9007199254740993',httpStatus:200,receivedAt:at,clientValidationCode:null});
async function save(bytes=Buffer.from('SYNTHETIC'),m=input(),operation=randomUUID()){return archive.saveResponse(owner,reg.id,operation,m,bytes);}
async function count(table:string){return Number((await sql<{n:string}>`SELECT count(*) AS n FROM ${sql.id(table)}`.execute(database.db)).rows[0]!.n);}
async function corrupt(table:string,callback:(tx:typeof database.db)=>Promise<unknown>){
 expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 await database.db.transaction().execute(async tx=>{await sql`ALTER TABLE ${sql.id(table)} DISABLE TRIGGER USER`.execute(tx);
  await callback(tx);await sql`ALTER TABLE ${sql.id(table)} ENABLE TRIGGER USER`.execute(tx);});
}
it('initializes immutable owner-bound options; does not enable collection',async()=>{
 const h=await init();expect(await init()).toEqual(h);expect(h.collectionAllowed).toBe(false);
 await expect(init(2048)).rejects.toThrow('archive_options_changed');
 await expect(archive.initialize(owner,reg.id,'a'.repeat(64),{syntheticOnly:true,maxBytes:1024})).rejects.toThrow('archive_registration_hash');
 await expect(archive.initialize(randomUUID(),reg.id,reg.packageSha256,{syntheticOnly:true,maxBytes:1024})).rejects.toThrow();
 expect((await archive.replay(owner,reg.id)).entries).toBe(0);
});
it('deduplicates bytes, preserves original bytes and retries exactly without charging capacity',async()=>{
 await init(9);const m=input(),operation=randomUUID(),first=await save(Buffer.from('SYNTHETIC'),m,operation);
 expect(await save(Buffer.from('SYNTHETIC'),m,operation)).toEqual(first);await save();
 expect(await count('conditional_raw_blobs')).toBe(1);expect((await archive.capacity(owner,reg.id)).uniqueBytes).toBe(9);
 expect((await archive.readResponse(owner,reg.id,m.requestId)).bytes.equals(Buffer.from('SYNTHETIC'))).toBe(true);
 await expect(save(Buffer.from('changed'),m,operation)).rejects.toThrow('archive_capture_conflict');
 await expect(save(Buffer.from('SYNTHETIC'),input(),operation)).rejects.toThrow('archive_capture_conflict');
});
it('resumes a committed receipt after journal failure without supplying body or making HTTP',async()=>{
 const h=await init(),r=await save();
 await expect(archive.appendResponse(owner,reg.id,r.requestId,'a'.repeat(64))).rejects.toThrow('archive_head_conflict');
 expect((await archive.replay(owner,reg.id)).pendingRequestIds).toEqual([r.requestId]);
 const end=await archive.appendResponse(owner,reg.id,r.requestId,h.headSha256);
 expect(await archive.appendResponse(owner,reg.id,r.requestId,h.headSha256)).toEqual(end);
 await expect(archive.appendResponse(owner,reg.id,r.requestId,end.headSha256)).rejects.toThrow();
 expect(await archive.replay(owner,reg.id)).toMatchObject({status:'verified_archive',entries:1,uniqueBodies:1,headSha256:end.headSha256});
});
it('rolls back a new body when receipt validation fails; no orphan survives',async()=>{
 await init();await expect(save(Buffer.from('not committed'),{...input(),receivedAt:'2026-11-15T01:03:00.000Z'})).rejects.toThrow('archive_metadata_invalid');
 expect(await count('conditional_raw_blobs')).toBe(0);expect(await count('conditional_blob_receipts')).toBe(0);
 await expect(sql`INSERT INTO conditional_raw_blobs(registration_id,body_sha256,body,byte_length)
  VALUES(${reg.id}::uuid,${archiveSha('orphan')},${Buffer.from('orphan')},6)`.execute(database.db)).rejects.toThrow('archive_orphan_blob');
 expect(await count('conditional_raw_blobs')).toBe(0);
});
it('serializes concurrent byte-capacity claims and reports a non-reserving snapshot',async()=>{
 await init(9);const result=await Promise.allSettled([save(Buffer.from('123456')),save(Buffer.from('abcdef'))]);
 expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect((result.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.message).toContain('archive_capacity_exceeded');
 expect(await archive.capacity(owner,reg.id)).toMatchObject({uniqueBytes:6,availableBytes:3,reservation:false,canFitMaximumBody:false});
});
it('serializes duplicate capture retries and separate journal CAS appends',async()=>{
 const h=await init(),m=input(),operation=randomUUID();const a=await Promise.all([save(Buffer.from('same'),m,operation),save(Buffer.from('same'),m,operation)]);
 expect(a[0]).toEqual(a[1]);expect(await count('conditional_blob_receipts')).toBe(1);
 const b=await save();const outcomes=await Promise.allSettled([archive.appendResponse(owner,reg.id,a[0].requestId,h.headSha256),archive.appendResponse(owner,reg.id,b.requestId,h.headSha256)]);
 expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);const replay=await archive.replay(owner,reg.id);
 expect(replay.entries).toBe(1);expect(replay.pendingRequestIds).toHaveLength(1);
 await archive.appendResponse(owner,reg.id,replay.pendingRequestIds[0],replay.headSha256);expect((await archive.replay(owner,reg.id)).entries).toBe(2);
});
it('enforces response count even when empty and duplicate bodies cost no extra bytes',async()=>{
 await init(9,2);await save(Buffer.alloc(0));await save(Buffer.alloc(0));await expect(save(Buffer.alloc(0))).rejects.toThrow('archive_response_limit');
 expect(await count('conditional_raw_blobs')).toBe(1);expect((await archive.replay(owner,reg.id)).capacity.uniqueBytes).toBe(0);
});
it('keeps invalid UTF8 and invalid JSON byte-exact, without treating them as map records',async()=>{
 await init();const bytes=Buffer.from([255,0,254]),r=await save(bytes,{...input(),clientValidationCode:'invalid_utf8'});
 expect((await archive.readResponse(owner,reg.id,r.requestId)).bytes.equals(bytes)).toBe(true);
 await save(Buffer.from('{not json'),{...input(),clientValidationCode:'invalid_json'});
 expect(await archive.replay(owner,reg.id)).toMatchObject({uniqueBodies:2,realEvaluationAllowed:false,deployable:false});
});
it('freezes caller body and metadata before asynchronous persistence',async()=>{
 await init();const bytes=Buffer.from('original'),m=input(),requestId=m.requestId,promise=save(bytes,m);
 bytes.fill(1);m.endpoint='/matches/3';await promise;
 const read=await archive.readResponse(owner,reg.id,requestId);expect(read.bytes.toString()).toBe('original');expect(read.metadata.endpoint).toBe('/matches/9007199254740993');
});
it('blocks inactive owner and ordinary user from archive reads and writes',async()=>{
 await init();await save();
 await sql`UPDATE app_users SET account_role='user' WHERE id=${owner}::uuid`.execute(database.db);
 await expect(archive.replay(owner,reg.id)).rejects.toThrow('archive_active_owner_required');await expect(save()).rejects.toThrow('archive_active_owner_required');
 await sql`UPDATE app_users SET account_role='owner',is_active=false WHERE id=${owner}::uuid`.execute(database.db);
 await expect(archive.capacity(owner,reg.id)).rejects.toThrow('archive_active_owner_required');
});
it('rejects direct SQL hash mismatch, duplicate JSON keys, unsupported metadata and stale isolation',async()=>{
 await init();await expect(sql`INSERT INTO conditional_raw_blobs(registration_id,body_sha256,body,byte_length)
  VALUES(${reg.id}::uuid,${'a'.repeat(64)},${Buffer.from('x')},1)`.execute(database.db)).rejects.toThrow('archive_body_integrity');
 const b=Buffer.from('x'),m=archiveMetadata(reg.id,input(),archiveBody(b),true);
 for(const text of [JSON.stringify({...m,httpStatus:200.5}),JSON.stringify({...m,collectionAllowed:true}),JSON.stringify(m).replace('"provider":"opendota"','"provider":"opendota","provider":"opendota"')]){
  await expect(database.db.transaction().execute(async tx=>{
   await sql`INSERT INTO conditional_raw_blobs(registration_id,body_sha256,body,byte_length) VALUES(${reg.id}::uuid,${archiveSha(b)},${b},1)`.execute(tx);
   await sql`INSERT INTO conditional_blob_receipts(registration_id,request_id,capture_operation_id,body_sha256,metadata_text)
    VALUES(${reg.id}::uuid,${m.requestId}::uuid,${randomUUID()}::uuid,${archiveSha(b)},${text})`.execute(tx);
  })).rejects.toThrow();
 }
 await expect(database.db.transaction().setIsolationLevel('repeatable read').execute(tx=>sql`SELECT conditional_blob_archive_lock(${reg.id}::uuid)`.execute(tx))).rejects.toThrow('archive_read_committed_required');
 expect(await count('conditional_raw_blobs')).toBe(0);
});
it('detects stored body corruption during replay and recovery',async()=>{
 const h=await init(),r=await save();await corrupt('conditional_raw_blobs',tx=>sql`UPDATE conditional_raw_blobs SET body=${Buffer.from('CORRUPTED')}`.execute(tx));
 await expect(archive.readResponse(owner,reg.id,r.requestId)).rejects.toThrow('archive_body_hash');
 await expect(archive.replay(owner,reg.id)).rejects.toThrow('archive_body_hash');
 await expect(archive.appendResponse(owner,reg.id,r.requestId,h.headSha256)).rejects.toThrow('archive_body_hash');
});
it('detects header, metadata and compact-chain corruption',async()=>{
 const h=await init(),r=await save();await archive.appendResponse(owner,reg.id,r.requestId,h.headSha256);
 await corrupt('conditional_blob_entries',tx=>sql`UPDATE conditional_blob_entries SET entry_text=entry_text||' '`.execute(tx));
 await expect(archive.replay(owner,reg.id)).rejects.toThrow('archive_entry_hash');
 await corrupt('conditional_blob_receipts',tx=>sql`UPDATE conditional_blob_receipts SET metadata_text=metadata_text||' '`.execute(tx));
 await expect(archive.readResponse(owner,reg.id,r.requestId)).rejects.toThrow('archive_receipt_hash');
 await corrupt('conditional_blob_archives',tx=>sql`UPDATE conditional_blob_archives SET header_text=header_text||' '`.execute(tx));
 await expect(archive.capacity(owner,reg.id)).rejects.toThrow('archive_header_hash');
});
it('protects every archive table against update, delete and truncate',async()=>{
 const h=await init(),r=await save();await archive.appendResponse(owner,reg.id,r.requestId,h.headSha256);
 for(const table of tables.filter(t=>t.startsWith('conditional_blob_')||t==='conditional_raw_blobs')){
  await expect(sql`UPDATE ${sql.id(table)} SET registration_id=registration_id`.execute(database.db)).rejects.toThrow('archive_immutable');
  await expect(sql`DELETE FROM ${sql.id(table)}`.execute(database.db)).rejects.toThrow('archive_immutable');
 }
 await expect(sql`TRUNCATE conditional_blob_entries,conditional_blob_receipts,conditional_raw_blobs,conditional_blob_archives,conditional_collection_v2_events,conditional_collection_v2_journals,conditional_v2_transport_receipts`.execute(database.db)).rejects.toThrow('archive_immutable');
});
it('preserves v2 collector closed gate; archive records are not request reservations',async()=>{
 await init();await save();
 expect((await sql`SELECT count(*) AS n FROM conditional_collection_journals`.execute(database.db)).rows[0]!.n).toBe('0');
 expect((await new ConditionalRegistrationV2Store(database.db).read(owner,reg.id)).collectionAllowed).toBe(false);
});
it('stores and streams verifies 72 MiB synthetic raw bytes while compact journal stays below 16 KiB',async()=>{
 const h=await init(80*1024*1024);let head=h.headSha256;
 for(let i=0;i<12;i++){
  const bytes=Buffer.alloc(6*1024*1024,65+i);Buffer.from('SYNTHETIC CAPACITY TEST ONLY').copy(bytes);
  const r=await save(bytes);head=(await archive.appendResponse(owner,reg.id,r.requestId,head)).headSha256;
 }
 const result=await archive.replay(owner,reg.id);
 expect(result).toMatchObject({status:'verified_archive',entries:12,uniqueBodies:12,capacity:{uniqueBytes:72*1024*1024}});
 expect(result.journalBytes).toBeLessThan(16384);expect(result.headSha256).toBe(head);
},120000);
