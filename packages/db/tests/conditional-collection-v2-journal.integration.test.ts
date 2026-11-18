import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sql} from '../dist/index.js';
import {ConditionalRegistrationV2Store} from '../../../tools/research/conditional-real-registration-v2-store.mjs';
import {ConditionalBlobArchive,archiveSha as sha,archiveCodePaths} from '../../../tools/research/conditional-blob-archive.mjs';
import {ConditionalCollectionV2Journal,collectionV2JournalPaths} from '../../../tools/research/conditional-collection-v2-journal.mjs';
import {inspectRealRegistrationEnvironment} from '../../../tools/research/conditional-real-registration.mjs';
import {registrationV2Fixture} from '../../../tests/fixtures/conditional-registration-v2.mjs';
let database:Awaited<ReturnType<typeof testDatabase>>,journal:ConditionalCollectionV2Journal,archive:ConditionalBlobArchive,owner:string,reg:{id:string;packageSha256:string};
let clockValue='2026-11-15T01:02:00.000Z';
const from='2026-11-20T00:00:00.000Z',end='2026-12-25T00:00:00.000Z';
const tables=['conditional_v2_transport_receipts','conditional_collection_v2_events','conditional_collection_v2_journals','conditional_blob_entries','conditional_blob_receipts','conditional_raw_blobs','conditional_blob_archives'];
async function clock(at:string){expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);clockValue=at;
 for(const name of ['conditional_real_registration_clock','conditional_collection_clock'])await sql`CREATE OR REPLACE FUNCTION ${sql.id(name)}() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS ${sql.lit(`SELECT '${at}'::timestamptz`)}`.execute(database.db);}
beforeAll(async()=>{
 database=await testDatabase();journal=new ConditionalCollectionV2Journal(database.db);archive=new ConditionalBlobArchive(database.db);
 owner=(await sql<{id:string}>`INSERT INTO app_users(login,password_hash,account_role) VALUES('synthetic-v2-journal-owner',${'x'.repeat(40)},'owner') RETURNING id`.execute(database.db)).rows[0]!.id;
 const p=await registrationV2Fixture(owner);p.executable.environmentText=await inspectRealRegistrationEnvironment();p.executable.environmentSha256=sha(p.executable.environmentText);
 for(const path of [...archiveCodePaths,...collectionV2JournalPaths])p.executable.code[path]=sha(await readFile(path));
 await clock('2026-11-15T01:00:00.000Z');const text=JSON.stringify(p);reg=await new ConditionalRegistrationV2Store(database.db).register(owner,text,sha(text));
},90000);
beforeEach(async()=>{
 expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 await database.db.transaction().execute(async tx=>{
  for(const t of tables)await sql`ALTER TABLE ${sql.id(t)} DISABLE TRIGGER USER`.execute(tx);
  await sql`TRUNCATE conditional_v2_transport_receipts,conditional_collection_v2_events,conditional_collection_v2_journals,conditional_blob_entries,conditional_blob_receipts,conditional_raw_blobs,conditional_blob_archives`.execute(tx);
  for(const t of tables)await sql`ALTER TABLE ${sql.id(t)} ENABLE TRIGGER USER`.execute(tx);
  await sql`UPDATE app_users SET is_active=true,account_role='owner' WHERE id=${owner}::uuid`.execute(tx);
 });await clock('2026-11-15T01:02:00.000Z');
});
afterAll(async()=>{await database?.close();},30000);
const options={syntheticOnly:true,maxBytes:32*1024*1024,maxResponses:1000};
const init=()=>journal.initialize(owner,reg.id,reg.packageSha256,options);
const append=(head:string,command:object,operation=randomUUID())=>journal.append(owner,reg.id,head,operation,command);
async function start(endpoint='/proMatches'){
 const h=await init();await clock(from);const requestId=randomUUID();return {requestId,result:await append(h.headSha256,{kind:'reserve',requestId,endpoint})};
}
const capture=(requestId:string,endpoint='/proMatches',bytes=Buffer.from('[]'))=>archive.saveResponse(owner,reg.id,randomUUID(),{requestId,endpoint,httpStatus:200,receivedAt:clockValue,clientValidationCode:null},bytes);
const fail=(requestId:string,status:number|null=null,retryAfterAt:string|null=null)=>({kind:'fail',requestId,httpStatus:status,code:status===null?'timeout':'http_error',retryAfterAt});
async function count(table:string){return Number((await sql<{n:string}>`SELECT count(*) AS n FROM ${sql.id(table)}`.execute(database.db)).rows[0]!.n);}
async function direct(command:object,expected?:string){const last=(await sql`SELECT sequence,head_sha256 FROM conditional_collection_v2_events ORDER BY sequence DESC LIMIT 1`.execute(database.db)).rows[0];
 const h=(await sql`SELECT header_sha256 FROM conditional_collection_v2_journals`.execute(database.db)).rows[0];const text=JSON.stringify(command);
 return sql`INSERT INTO conditional_collection_v2_events(registration_id,sequence,operation_id,command_text,command_sha256,parent_sha256)
  VALUES(${reg.id}::uuid,${last?Number(last.sequence)+1:0},${randomUUID()}::uuid,${text},${sha(text)},${expected??last?.head_sha256??h?.header_sha256})`.execute(database.db);}
it('initializes before window without granting dispatch, and replays exact header on retry',async()=>{
 const a=await init();expect(await init()).toEqual(a);expect(a.reasons).toContain('COLLECTION_NOT_STARTED');expect(a.dispatchAllowed).toBe(false);
 await expect(append(a.headSha256,{kind:'reserve',requestId:randomUUID(),endpoint:'/proMatches'})).rejects.toThrow('window_closed');
 expect(await count('conditional_collection_v2_events')).toBe(0);
});
it('refuses enrollment of an archive containing unreserved old responses',async()=>{
 await archive.initialize(owner,reg.id,reg.packageSha256,options);await capture(randomUUID());
 await expect(init()).rejects.toThrow('empty_bound_archive_required');expect(await count('conditional_collection_v2_journals')).toBe(0);
});
it('reserves once, captures byte-exact response and completes both chains atomically',async()=>{
 const {requestId,result}=await start('/leagues/90001/matches');await capture(requestId,'/leagues/90001/matches');
 const after=await append(result.headSha256,{kind:'complete',requestId});expect(after.event.kind).toBe('archived');
 const read=await journal.read(owner,reg.id);expect(read.attempts.total).toBe(1);expect(read.pendingRequest).toBeNull();
 expect(read.archive).toMatchObject({verified:true,receipts:1,entries:1,uniqueBytes:2});expect(read.verifiedProMaps).toBeNull();
});
it('serializes competing starts and preserves exact operation retries after deadline',async()=>{
 const h=await init();await clock(from);const operation=randomUUID(),c={kind:'reserve',requestId:randomUUID(),endpoint:'/proMatches'};
 const results=await Promise.all([append(h.headSha256,c,operation),append(h.headSha256,c,operation)]);
 expect(results.map(x=>x.operationStatus).sort()).toEqual(['already_recorded','recorded']);
 await expect(append(h.headSha256,{...c,endpoint:'/leagues/90001/matches'},operation)).rejects.toThrow('operation_payload_changed');
 await expect(append(results[0].headSha256,{kind:'reserve',requestId:randomUUID(),endpoint:'/proMatches'})).rejects.toThrow('request_in_flight');
 await expect(append(h.headSha256,{kind:'reserve',requestId:randomUUID(),endpoint:'/proMatches'})).rejects.toThrow('head_conflict');
 await clock(end);expect((await append(h.headSha256,c,operation)).operationStatus).toBe('already_recorded');expect(await count('conditional_collection_v2_events')).toBe(1);
});
it('rejects a receipt without matching reservation, endpoint or observed time',async()=>{
 const h=await init();await expect(capture(randomUUID())).rejects.toThrow('receipt_reservation_binding');expect(await count('conditional_raw_blobs')).toBe(0);
 await clock(from);const requestId=randomUUID();await append(h.headSha256,{kind:'reserve',requestId,endpoint:'/proMatches'});
 await expect(capture(requestId,'/matches/1')).rejects.toThrow('receipt_reservation_binding');
 await expect(archive.saveResponse(owner,reg.id,randomUUID(),{requestId,endpoint:'/proMatches',httpStatus:200,receivedAt:'2026-11-19T23:59:59.000Z',clientValidationCode:null},Buffer.from('[]'))).rejects.toThrow('receipt_reservation_binding');
 expect(await count('conditional_raw_blobs')).toBe(0);
});
it('rolls back archive-entry append when journal completion fails; resumes saved bytes without HTTP',async()=>{
 const {requestId,result}=await start();await capture(requestId);
 await sql`ALTER TABLE conditional_collection_v2_events ADD CONSTRAINT synthetic_completion_failure CHECK(event_text::jsonb->>'kind'<>'archived')`.execute(database.db);
 await expect(append(result.headSha256,{kind:'complete',requestId})).rejects.toThrow('synthetic_completion_failure');
 await sql`ALTER TABLE conditional_collection_v2_events DROP CONSTRAINT synthetic_completion_failure`.execute(database.db);
 expect(await count('conditional_blob_entries')).toBe(0);expect(await count('conditional_blob_receipts')).toBe(1);
 expect((await journal.read(owner,reg.id)).archive.pendingReceiptRequestId).toBe(requestId);
 await expect(append(result.headSha256,fail(requestId))).rejects.toThrow('saved_receipt_requires_completion');
 await clock('2026-11-20T00:03:00.000Z');await expect(append(result.headSha256,{kind:'recover',requestId,reason:'Transport outcome is unknown after interruption'})).rejects.toThrow('saved_receipt_requires_completion');
 await append(result.headSha256,{kind:'complete',requestId});expect((await journal.read(owner,reg.id)).archive.entries).toBe(1);
});
it('accepts an independently appended archive entry without duplicating it',async()=>{
 const {requestId,result}=await start();await capture(requestId);const a=await archive.replay(owner,reg.id);
 await archive.appendResponse(owner,reg.id,requestId,a.headSha256);await append(result.headSha256,{kind:'complete',requestId});expect(await count('conditional_blob_entries')).toBe(1);
});
it('unknown outcome recovery requires two minutes and never returns its charged attempt',async()=>{
 const {requestId,result}=await start(),c={kind:'recover',requestId,reason:'Operator acknowledges missing response after crash'};
 await expect(append(result.headSha256,c)).rejects.toThrow('recovery_not_expired');await clock('2026-11-20T00:02:00.000Z');
 const recovered=await append(result.headSha256,c);expect(recovered.attempts).toMatchObject({total:1,unknown:1});
 await expect(capture(requestId)).rejects.toThrow('receipt_reservation_binding');
 await expect(append(recovered.headSha256,{kind:'reserve',requestId:randomUUID(),endpoint:'/proMatches'})).rejects.toThrow('retry_after_active');
 await clock('2026-11-20T00:02:05.000Z');expect((await append(recovered.headSha256,{kind:'reserve',requestId:randomUUID(),endpoint:'/proMatches'})).attempts.total).toBe(2);
});
it('honors Retry-After and permanently stops fresh attempts after provider authentication failure',async()=>{
 const {requestId,result}=await start();const failed=await append(result.headSha256,fail(requestId,429,'2026-11-20T00:10:00.000Z'));
 await clock('2026-11-20T00:09:59.999Z');await expect(append(failed.headSha256,{kind:'reserve',requestId:randomUUID(),endpoint:'/proMatches'})).rejects.toThrow('retry_after_active');
 await clock('2026-11-20T00:10:00.000Z');const q=randomUUID(),reserved=await append(failed.headSha256,{kind:'reserve',requestId:q,endpoint:'/proMatches'});
 const stopped=await append(reserved.headSha256,fail(q,403));await clock('2026-11-21T00:00:00.000Z');
 await expect(append(stopped.headSha256,{kind:'reserve',requestId:randomUUID(),endpoint:'/proMatches'})).rejects.toThrow('provider_auth_failed');
});
it('collection may finish existing requests at assessment boundary but cannot start new ones',async()=>{
 const h=await init();await clock('2026-12-24T23:59:59.000Z');const requestId=randomUUID(),s=await append(h.headSha256,{kind:'reserve',requestId,endpoint:'/proMatches'});
 await clock(end);await capture(requestId);const finished=await append(s.headSha256,{kind:'complete',requestId});
 await expect(append(finished.headSha256,{kind:'reserve',requestId:randomUUID(),endpoint:'/proMatches'})).rejects.toThrow('window_closed');
});
it('checks available maximum-body space before spending an attempt',async()=>{
 const h=await journal.initialize(owner,reg.id,reg.packageSha256,{syntheticOnly:true,maxBytes:8388607});await clock(from);
 await expect(append(h.headSha256,{kind:'reserve',requestId:randomUUID(),endpoint:'/proMatches'})).rejects.toThrow('archive_capacity');
 expect(await count('conditional_collection_v2_events')).toBe(0);
});
it('SQL rejects unknown fields, foreign leagues, invalid failure pairs, stale isolation and receipt-free completion',async()=>{
 await init();await clock(from);
 for(const c of [{kind:'reserve',requestId:randomUUID(),endpoint:'/proMatches',dispatchAllowed:true},{kind:'reserve',requestId:randomUUID(),endpoint:'/leagues/1/matches'}])await expect(direct(c)).rejects.toThrow();
 const requestId=randomUUID();await direct({kind:'reserve',requestId,endpoint:'/proMatches'});
 await expect(direct({kind:'complete',requestId})).rejects.toThrow('receipt_missing');
 for(const c of [{...fail(requestId),httpStatus:200},{...fail(requestId),httpStatus:429},{...fail(requestId),code:null},{...fail(requestId),retryAfterAt:null,extra:true},
  {...fail(requestId,400),httpStatus:400.2},{...fail(requestId,429),retryAfterAt:'2026-02-30T00:00:00.000Z'},
  {...fail(requestId,429),retryAfterAt:'2026-11-20T00:00:60.000Z'}])await expect(direct(c)).rejects.toThrow();
 await expect(database.db.transaction().setIsolationLevel('repeatable read').execute(tx=>sql`SELECT conditional_blob_archive_lock(${reg.id}::uuid)`.execute(tx))).rejects.toThrow('read_committed_required');
 expect(await count('conditional_collection_v2_events')).toBe(1);
});
it('owner checks and immutable event/header guards protect stored state',async()=>{
 const {result}=await start();await expect(journal.read(randomUUID(),reg.id)).rejects.toThrow();
 await sql`UPDATE app_users SET account_role='user' WHERE id=${owner}::uuid`.execute(database.db);await expect(journal.read(owner,reg.id)).rejects.toThrow();
 await sql`UPDATE app_users SET account_role='owner' WHERE id=${owner}::uuid`.execute(database.db);
 for(const table of ['conditional_collection_v2_events','conditional_collection_v2_journals']){
  await expect(sql`UPDATE ${sql.id(table)} SET registration_id=registration_id`.execute(database.db)).rejects.toThrow('immutable');
  await expect(sql`DELETE FROM ${sql.id(table)}`.execute(database.db)).rejects.toThrow('immutable');}
 await expect(sql`TRUNCATE conditional_collection_v2_events,conditional_collection_v2_journals,conditional_v2_transport_receipts`.execute(database.db)).rejects.toThrow('immutable');
 expect((await journal.read(owner,reg.id)).headSha256).toBe(result.headSha256);
});
it('detects privileged corruption of raw bytes and journal chain, including recovery path',async()=>{
 const {requestId,result}=await start();await capture(requestId);
 await database.db.transaction().execute(async tx=>{await sql`ALTER TABLE conditional_raw_blobs DISABLE TRIGGER USER`.execute(tx);
  await sql`UPDATE conditional_raw_blobs SET body=${Buffer.from('{}')}`.execute(tx);await sql`ALTER TABLE conditional_raw_blobs ENABLE TRIGGER USER`.execute(tx);});
 await expect(journal.read(owner,reg.id)).rejects.toThrow('archive_body_hash');await expect(append(result.headSha256,{kind:'complete',requestId})).rejects.toThrow('receipt_integrity');
 await database.db.transaction().execute(async tx=>{await sql`ALTER TABLE conditional_collection_v2_events DISABLE TRIGGER USER`.execute(tx);
  await sql`UPDATE conditional_collection_v2_events SET event_text=event_text||' '`.execute(tx);await sql`ALTER TABLE conditional_collection_v2_events ENABLE TRIGGER USER`.execute(tx);});
 await expect(journal.read(owner,reg.id)).rejects.toThrow('event_chain_hash');
});
it('uses advancing server clocks when archive insertion takes place after initial completion checks',async()=>{
 const {requestId,result}=await start();await capture(requestId);
 const anchor=(await sql<{at:Date}>`SELECT clock_timestamp() AS at`.execute(database.db)).rows[0]!.at.toISOString();
 for(const name of ['conditional_real_registration_clock','conditional_collection_clock'])await sql`CREATE OR REPLACE FUNCTION ${sql.id(name)}() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS
  ${sql.lit(`SELECT date_trunc('milliseconds','${from}'::timestamptz+(clock_timestamp()-'${anchor}'::timestamptz))`)}`.execute(database.db);
 const completed=await append(result.headSha256,{kind:'complete',requestId});expect(completed.event.kind).toBe('archived');expect((await journal.read(owner,reg.id)).archive.verified).toBe(true);
});
it('enforces actual 100/day and 1000 total budgets across UTC days without resetting or refunding failures',async()=>{
 await init();expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 await sql`CREATE OR REPLACE FUNCTION conditional_collection_clock() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS ${sql.lit("SELECT current_setting('codex.fixture_clock')::timestamptz")}`.execute(database.db);
 // All loops and the fixture clock stay inside this disposable DB transaction.
 const script=`DECLARE j integer; q uuid; c jsonb; seq integer; parent text; reg uuid := '${reg.id}'; base timestamptz; BEGIN
 FOR j IN 0..999 LOOP
  base := '2026-11-20T00:00:00Z'::timestamptz + (j/100)*interval '1 day' + (j%100)*interval '10 seconds';q:=gen_random_uuid();
  FOR seq IN 0..1 LOOP
   PERFORM set_config('codex.fixture_clock',(base+seq*interval '1 second')::text,true);
   IF seq=0 THEN c:=jsonb_build_object('kind','reserve','requestId',q,'endpoint','/proMatches');
   ELSE c:=jsonb_build_object('kind','fail','requestId',q,'httpStatus',NULL,'code','timeout','retryAfterAt',NULL); END IF;
   SELECT head_sha256 INTO parent FROM conditional_collection_v2_events WHERE registration_id=reg ORDER BY sequence DESC LIMIT 1;
   IF parent IS NULL THEN SELECT header_sha256 INTO parent FROM conditional_collection_v2_journals WHERE registration_id=reg; END IF;
   INSERT INTO conditional_collection_v2_events(registration_id,sequence,operation_id,command_text,command_sha256,parent_sha256)
    VALUES(reg,j*2+seq,gen_random_uuid(),c::text,encode(sha256(convert_to(c::text,'UTF8')),'hex'),parent);
  END LOOP;
  IF j=99 THEN
   PERFORM set_config('codex.fixture_clock','2026-11-20T01:00:00Z',true);c:=jsonb_build_object('kind','reserve','requestId',gen_random_uuid(),'endpoint','/proMatches');
   SELECT head_sha256 INTO parent FROM conditional_collection_v2_events WHERE registration_id=reg ORDER BY sequence DESC LIMIT 1;
   BEGIN
    INSERT INTO conditional_collection_v2_events(registration_id,sequence,operation_id,command_text,command_sha256,parent_sha256)
     VALUES(reg,200,gen_random_uuid(),c::text,encode(sha256(convert_to(c::text,'UTF8')),'hex'),parent);
    RAISE EXCEPTION 'daily limit unexpectedly accepted';
   EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'collection_v2_daily_budget_exhausted' THEN RAISE; END IF; END;
  END IF;
 END LOOP;END;`;
 await sql`DO ${sql.lit(script)}`.execute(database.db);await clock('2026-11-30T00:00:00.000Z');
 const read=await journal.read(owner,reg.id);expect(read.attempts).toMatchObject({total:1000,failed:1000});expect(Object.values(read.attempts.byUtcDay)).toEqual(Array(10).fill(100));
 await expect(append(read.headSha256,{kind:'reserve',requestId:randomUUID(),endpoint:'/proMatches'})).rejects.toThrow('total_budget_exhausted');
 expect(await count('conditional_collection_v2_events')).toBe(2000);
},120000);
