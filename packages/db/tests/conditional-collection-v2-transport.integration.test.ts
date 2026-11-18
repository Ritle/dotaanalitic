import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {createServer,type ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sql} from '../dist/index.js';
import {ConditionalRegistrationV2Store} from '../../../tools/research/conditional-real-registration-v2-store.mjs';
import {ConditionalBlobArchive,archiveCodePaths,archiveSha as sha} from '../../../tools/research/conditional-blob-archive.mjs';
import {ConditionalCollectionV2Journal,collectionV2JournalPaths} from '../../../tools/research/conditional-collection-v2-journal.mjs';
import {LocalConditionalCollectionV2Transport,collectionV2TransportPaths} from '../../../tools/research/conditional-collection-v2-transport.mjs';
import {PostgresProviderBudget} from '../../ingestion/dist/quota.js';
import {inspectRealRegistrationEnvironment} from '../../../tools/research/conditional-real-registration.mjs';
import {registrationV2Fixture} from '../../../tests/fixtures/conditional-registration-v2.mjs';
import {map} from '../../../tests/fixtures/conditional-registered-collector.mjs';
let database:Awaited<ReturnType<typeof testDatabase>>,journal:ConditionalCollectionV2Journal,archive:ConditionalBlobArchive,owner:string,id:string,packageSha:string;
let localOrigin:string,hits=0,paths:string[],handler:(res:ServerResponse)=>void;
const server=createServer((req,res)=>{hits++;paths.push(req.url!);expect(req.headers.authorization).toBeUndefined();handler(res);});
const at='2026-11-20T00:00:00.000Z';
const tables=['conditional_v2_transport_receipts','conditional_collection_v2_events','conditional_collection_v2_journals','conditional_blob_entries','conditional_blob_receipts','conditional_raw_blobs','conditional_blob_archives'];
async function clock(value:string){expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 for(const name of ['conditional_real_registration_clock','conditional_collection_clock'])await sql`CREATE OR REPLACE FUNCTION ${sql.id(name)}() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS ${sql.lit(`SELECT '${value}'::timestamptz`)}`.execute(database.db);}
beforeAll(async()=>{
 database=await testDatabase();journal=new ConditionalCollectionV2Journal(database.db);archive=new ConditionalBlobArchive(database.db);
 owner=(await sql<{id:string}>`INSERT INTO app_users(login,password_hash,account_role) VALUES('synthetic-v2-transport-owner',${'x'.repeat(40)},'owner') RETURNING id`.execute(database.db)).rows[0]!.id;
 const p=await registrationV2Fixture(owner);p.executable.environmentText=await inspectRealRegistrationEnvironment();p.executable.environmentSha256=sha(p.executable.environmentText);
 for(const path of [...archiveCodePaths,...collectionV2JournalPaths,...collectionV2TransportPaths])p.executable.code[path]=sha(await readFile(path));
 await clock('2026-11-15T01:00:00.000Z');const text=JSON.stringify(p),r=await new ConditionalRegistrationV2Store(database.db).register(owner,text,sha(text));id=r.id;packageSha=r.packageSha256;
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('fixture_server');localOrigin=`http://127.0.0.1:${address.port}`;
},90000);
beforeEach(async()=>{
 expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 await database.db.transaction().execute(async tx=>{for(const t of tables)await sql`ALTER TABLE ${sql.id(t)} DISABLE TRIGGER USER`.execute(tx);
  await sql`TRUNCATE conditional_v2_transport_receipts,conditional_collection_v2_events,conditional_collection_v2_journals,conditional_blob_entries,conditional_blob_receipts,conditional_raw_blobs,conditional_blob_archives`.execute(tx);
  for(const t of tables)await sql`ALTER TABLE ${sql.id(t)} ENABLE TRIGGER USER`.execute(tx);
  await sql`DELETE FROM provider_quotas`.execute(tx);await sql`UPDATE app_users SET is_active=true,account_role='owner' WHERE id=${owner}::uuid`.execute(tx);
 });await clock('2026-11-15T01:02:00.000Z');hits=0;paths=[];handler=res=>res.end('[]');
});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await database?.close();},30000);
const transport=(options:object={})=>new LocalConditionalCollectionV2Transport(database.db,{localOrigin,...options});
async function input(syntheticOnly=true){const h=await journal.initialize(owner,id,packageSha,{syntheticOnly,maxBytes:64*1024*1024});await clock(at);
 return {ownerId:owner,registrationId:id,expectedHeadSha256:h.headSha256,operationId:randomUUID(),requestId:randomUUID(),endpoint:'/proMatches'};}
async function receipt(){const row=(await sql<{receipt_text:string;receipt_sha256:string}>`SELECT receipt_text,receipt_sha256 FROM conditional_v2_transport_receipts ORDER BY saved_at,request_id LIMIT 1`.execute(database.db)).rows[0]!;
 expect(sha(row.receipt_text)).toBe(row.receipt_sha256);return JSON.parse(row.receipt_text);}
async function count(table:string){return Number((await sql<{n:string}>`SELECT count(*) AS n FROM ${sql.id(table)}`.execute(database.db)).rows[0]!.n);}
async function usage(){return (await sql<{n:number}>`SELECT month_used AS n FROM provider_quotas WHERE provider='opendota'`.execute(database.db)).rows[0]?.n??0;}
async function releaseFixtureSpacing(){expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);await sql`UPDATE provider_quotas SET next_request_at='-infinity'`.execute(database.db);}
it('commits raw bytes and compact receipt, finalizes once and never repeats a wire request on retry',async()=>{
 const command=await input(),done=await transport().execute(command);expect(done.status).toBe('completed');expect(done.state.attempts.total).toBe(1);
 expect(hits).toBe(1);expect(await usage()).toBe(1);const r=await receipt();expect(r.command).toEqual({kind:'complete',requestId:command.requestId});
 expect(r.observedAt).toBe(at);expect(r.bodySha256).toBe(sha('[]'));expect(r.quotaClaimed).toBe(true);expect(r.sendInvokedAt<=r.responseHeadersAt&&r.responseHeadersAt<=r.bodyCompletedAt).toBe(true);
 expect((await archive.readResponse(owner,id,command.requestId)).bytes.toString()).toBe('[]');expect((await journal.read(owner,id)).archive.entries).toBe(1);
 expect((await transport().finalize(owner,id,command.requestId)).operationStatus).toBe('already_recorded');expect((await transport().execute(command)).status).toBe('already_reserved');expect(hits).toBe(1);
});
it('concurrent identical callers send once and spend one shared quota claim',async()=>{
 const command=await input(),done=await Promise.all([transport().execute(command),transport().execute(command)]);
 expect(done.map(x=>x.status).sort()).toEqual(['already_reserved','completed']);expect(hits).toBe(1);expect(await usage()).toBe(1);
});
it('retains complete invalid JSON and records validation without calling it verified map data',async()=>{
 handler=res=>res.end('{broken');const command=await input(),done=await transport().execute(command);
 expect(done.clientValidationCode).toBe('source_invalid_json');expect(done.state.verifiedProMaps).toBeNull();expect(done.state.denominatorComplete).toBe(false);
 expect((await archive.readResponse(owner,id,command.requestId)).bytes.toString()).toBe('{broken');expect((await receipt()).command.kind).toBe('complete');
});
it('retains invalid UTF8 byte-exact instead of replacing bytes with Unicode replacement characters',async()=>{
 const bytes=Buffer.from([255,0,254]);handler=res=>res.end(bytes);const command=await input(),done=await transport().execute(command);
 expect(done.clientValidationCode).toBe('source_invalid_encoding');expect((await archive.readResponse(owner,id,command.requestId)).bytes.equals(bytes)).toBe(true);
});
it('retains empty 204 body and bodies larger than the legacy 1 MiB limit without inline journal copies',async()=>{
 const command=await input();handler=res=>{res.writeHead(204);res.end();};let done=await transport().execute(command);
 expect((await archive.readResponse(owner,id,command.requestId)).bytes.length).toBe(0);expect((await receipt()).bodyBytes).toBe(0);
 const bytes=Buffer.from(JSON.stringify({syntheticOnly:true,padding:'x'.repeat(2*1024*1024)}));handler=res=>res.end(bytes);await releaseFixtureSpacing();
 const requestId=randomUUID();done=await transport().execute({...command,requestId,operationId:randomUUID(),expectedHeadSha256:done.state.headSha256});
 expect((await archive.readResponse(owner,id,requestId)).bytes.equals(bytes)).toBe(true);
 const sizes=(await sql<{largest:number}>`SELECT max(octet_length(receipt_text)) AS largest FROM conditional_v2_transport_receipts`.execute(database.db)).rows[0]!;
 expect(sizes.largest).toBeLessThan(4096);expect(hits).toBe(2);expect(await usage()).toBe(2);
});
it('429 honors Retry-After in both ledger and shared quota with no hidden retry',async()=>{
 handler=res=>{res.writeHead(429,{'Retry-After':'60'});res.end('synthetic error body is not archived');};const command=await input(),done=await transport().execute(command);
 expect(done.state.cooldownUntil).toBe('2026-11-20T00:01:00.000Z');expect((await receipt()).command).toMatchObject({kind:'fail',httpStatus:429,code:'http_error'});
 expect(hits).toBe(1);expect(await usage()).toBe(1);expect(await count('conditional_raw_blobs')).toBe(0);
 expect((await new PostgresProviderBudget(database.db).claim()).allowed).toBe(false);
 await expect(transport().execute({...command,requestId:randomUUID(),operationId:randomUUID(),expectedHeadSha256:done.state.headSha256})).rejects.toThrow('retry_after_active');expect(hits).toBe(1);
});
it('provider daily quota denies send but its charged journal attempt and detailed reason remain explicit',async()=>{
 const command=await input();await new PostgresProviderBudget(database.db).claim();await sql`UPDATE provider_quotas SET day_used=2000`.execute(database.db);
 const done=await transport().execute(command),r=await receipt();expect(hits).toBe(0);expect(await usage()).toBe(1);expect(done.state.attempts.total).toBe(1);
 expect(r).toMatchObject({quotaClaimed:false,quotaPeriod:'day',clientValidationCode:'request_budget_exhausted',sendInvokedAt:null,bodySha256:null});
 expect(r.command).toMatchObject({kind:'fail',httpStatus:null,code:'cancelled'});expect(r.command.retryAfterAt).not.toBeNull();
});
it('503 and zero remaining headers update shared cooldown; client sends only once',async()=>{
 handler=res=>{res.writeHead(503,{'Retry-After':'60','x-rate-limit-remaining-day':'0'});res.end();};await transport().execute(await input());
 expect(hits).toBe(1);expect((await receipt()).command.httpStatus).toBe(503);
 expect((await new PostgresProviderBudget(database.db).claim()).allowed).toBe(false);
});
it('oversized and interrupted bodies are failures and never retained as complete raw responses',async()=>{
 handler=res=>res.end('x'.repeat(100));const command=await input();await transport({maxResponseBytes:20}).execute(command);
 expect((await receipt()).command.code).toBe('body_limit');expect(await count('conditional_raw_blobs')).toBe(0);expect((await receipt()).bodyCompletedAt).toBeNull();
});
it('socket interruption is distinguished from invalid complete JSON',async()=>{
 handler=res=>{res.writeHead(200);res.write('[');setTimeout(()=>res.destroy(),100);};await transport().execute(await input());
 expect((await receipt()).command.code).toBe('incomplete_body');expect(await count('conditional_raw_blobs')).toBe(0);
});
it('timeout during a streaming body closes the attempt without retaining a prefix',async()=>{
 handler=res=>{res.writeHead(200);res.write('[');};await transport({timeoutMs:2000}).execute(await input());
 expect(hits).toBe(1);expect((await receipt()).command.code).toBe('timeout');expect(await count('conditional_raw_blobs')).toBe(0);server.closeAllConnections();
});
it('cancellation before reserve spends nothing; cancellation during response persists a failed attempt',async()=>{
 const command=await input(),early=new AbortController();early.abort();await expect(transport().execute(command,{signal:early.signal})).rejects.toThrow();
 expect(await count('conditional_collection_v2_events')).toBe(0);expect(await usage()).toBe(0);
 const controller=new AbortController();handler=res=>{res.writeHead(200);res.write('[');controller.abort();};await transport().execute(command,{signal:controller.signal});
 expect(hits).toBe(1);expect((await receipt()).command.code).toBe('cancelled');expect(await count('conditional_raw_blobs')).toBe(0);server.closeAllConnections();
});
it('redirects cannot leave loopback and real/unauthorized registrations never dispatch',async()=>{
 const real=await input(false);await expect(transport().execute(real)).rejects.toThrow('synthetic_transport_only');await expect(transport().execute({...real,ownerId:randomUUID()})).rejects.toThrow();
 expect(hits).toBe(0);expect(await usage()).toBe(0);
});
it('does not follow fixture HTTP redirects',async()=>{
 handler=res=>{res.writeHead(302,{Location:'https://api.opendota.com/api/proMatches'});res.end();};await transport().execute(await input());
 expect(hits).toBe(1);expect((await receipt()).command.kind).toBe('fail');expect(await count('conditional_raw_blobs')).toBe(0);
});
it('receipt persistence failure rolls back body and both receipts; repeated execute does not refetch',async()=>{
 const command=await input();await sql`ALTER TABLE conditional_v2_transport_receipts ADD CONSTRAINT synthetic_save_failure CHECK(false)`.execute(database.db);
 try{await expect(transport().execute(command)).rejects.toThrow('receipt_persistence_unknown');}finally{await sql`ALTER TABLE conditional_v2_transport_receipts DROP CONSTRAINT synthetic_save_failure`.execute(database.db);}
 for(const table of ['conditional_v2_transport_receipts','conditional_blob_receipts','conditional_raw_blobs'])expect(await count(table)).toBe(0);
 expect((await journal.read(owner,id)).pendingRequest.requestId).toBe(command.requestId);expect((await transport().execute(command)).status).toBe('already_reserved');expect(hits).toBe(1);
});
it('completion rollback leaves a recoverable transport receipt and raw body; restart performs no HTTP',async()=>{
 const command=await input();await sql`ALTER TABLE conditional_collection_v2_events ADD CONSTRAINT synthetic_end_failure CHECK(sequence<1)`.execute(database.db);
 try{await expect(transport().execute(command)).rejects.toThrow('completion_pending_receipt_saved');}finally{await sql`ALTER TABLE conditional_collection_v2_events DROP CONSTRAINT synthetic_end_failure`.execute(database.db);}
 expect(await count('conditional_v2_transport_receipts')).toBe(1);expect(await count('conditional_raw_blobs')).toBe(1);expect(await count('conditional_blob_entries')).toBe(0);
 await transport().finalize(owner,id,command.requestId);expect((await transport().execute(command)).status).toBe('already_reserved');expect(hits).toBe(1);expect(await usage()).toBe(1);
});
it('a saved HTTP failure cannot be replaced with manual recovery or a command that removes Retry-After',async()=>{
 handler=res=>{res.writeHead(429,{'Retry-After':'60'});res.end();};const command=await input();await sql`ALTER TABLE conditional_collection_v2_events ADD CONSTRAINT synthetic_end_failure CHECK(sequence<1)`.execute(database.db);
 try{await expect(transport().execute(command)).rejects.toThrow('completion_pending_receipt_saved');}finally{await sql`ALTER TABLE conditional_collection_v2_events DROP CONSTRAINT synthetic_end_failure`.execute(database.db);}
 const state=await journal.read(owner,id);await clock('2026-11-20T00:02:00.000Z');
 await expect(journal.append(owner,id,state.headSha256,randomUUID(),{kind:'recover',requestId:command.requestId,reason:'Synthetic attempted replacement of saved HTTP result'})).rejects.toThrow('transport_completion_binding');
 const r=await receipt();await expect(journal.append(owner,id,state.headSha256,r.completionOperationId,{...r.command,retryAfterAt:null})).rejects.toThrow('transport_completion_binding');
 await transport().finalize(owner,id,command.requestId);expect(hits).toBe(1);
});
it('quota observation failure remains durable and blocks further transport until explicit reconciliation',async()=>{
 const worker=transport();worker.quota.observe=async()=>{throw Error('synthetic quota DB failure');};const command=await input(),done=await worker.execute(command);
 expect(done.quotaObservationFailed).toBe(true);expect((await receipt()).quotaObservationFailed).toBe(true);
 await expect(transport().execute({...command,requestId:randomUUID(),operationId:randomUUID(),expectedHeadSha256:done.state.headSha256})).rejects.toThrow('quota_reconciliation_required');
 expect((await transport().finalize(owner,id,command.requestId)).operationStatus).toBe('already_recorded');expect(hits).toBe(1);
});
it('stale or closed-window reservation after quota admission is not sent',async()=>{
 const worker=transport(),claim=worker.quota.claim.bind(worker.quota);worker.quota.claim=async()=>{const r=await claim();await clock('2026-11-20T00:00:30.000Z');return r;};
 await worker.execute(await input());expect(hits).toBe(0);expect(await usage()).toBe(1);expect((await receipt()).clientValidationCode).toBe('stale_dispatch_reservation');
});
it('lost reservation commit acknowledgement never permits a second dispatch',async()=>{
 const worker=transport(),command=await input(),append=worker.journal.append.bind(worker.journal);worker.journal.append=async(...args:unknown[])=>{await append(...args);throw Error('synthetic lost reserve acknowledgment');};
 await expect(worker.execute(command)).rejects.toThrow('lost reserve');expect((await transport().execute(command)).status).toBe('already_reserved');expect(hits).toBe(0);expect(await usage()).toBe(0);
});
it('transport receipts reject mutation and detect privileged hash corruption',async()=>{
 const command=await input();await transport().execute(command);
 for(const q of [sql`UPDATE conditional_v2_transport_receipts SET receipt_text=receipt_text`,sql`DELETE FROM conditional_v2_transport_receipts`,sql`TRUNCATE conditional_v2_transport_receipts`])await expect(q.execute(database.db)).rejects.toThrow('immutable');
 await database.db.transaction().execute(async tx=>{await sql`ALTER TABLE conditional_v2_transport_receipts DISABLE TRIGGER USER`.execute(tx);
  await sql`UPDATE conditional_v2_transport_receipts SET receipt_text=receipt_text||' '`.execute(tx);await sql`ALTER TABLE conditional_v2_transport_receipts ENABLE TRIGGER USER`.execute(tx);});
 await expect(transport().finalize(owner,id,command.requestId)).rejects.toThrow('receipt_hash');expect(hits).toBe(1);
});
it('named client handles registered league, BIGINT detail and cursor endpoints using the same shared quota',async()=>{
 const command=await input();handler=res=>res.end(JSON.stringify([map()]));let done=await transport().execute({...command,endpoint:'/leagues/90001/matches'});
 for(const [endpoint,payload] of [['/matches/9007199254741201',map()],['/proMatches?less_than_match_id=9007199254741201',[]]] as const){
  await releaseFixtureSpacing();handler=res=>res.end(JSON.stringify(payload));done=await transport().execute({...command,requestId:randomUUID(),operationId:randomUUID(),expectedHeadSha256:done.state.headSha256,endpoint});}
 expect(paths).toEqual(['/leagues/90001/matches','/matches/9007199254741201','/proMatches?less_than_match_id=9007199254741201']);expect(await usage()).toBe(3);expect(done.state.denominatorComplete).toBe(false);
});
it('direct SQL refuses malformed receipt claims and preserves the pending request for valid completion',async()=>{
 handler=res=>{res.writeHead(503);res.end();};const command=await input(),worker=transport();let captured:Record<string,unknown>|undefined;
 worker.saveReceipt=async(_owner:string,raw:unknown)=>{captured=structuredClone(raw) as Record<string,unknown>;throw Error('synthetic pre-persistence interruption');};
 await expect(worker.execute(command)).rejects.toThrow('receipt_persistence_unknown');expect(captured).toBeDefined();const r=captured!,outcome=r.command as Record<string,unknown>;
 const candidates=[{...r,apiKey:'synthetic-do-not-store'},{...r,syntheticOnly:false},{...r,reservationHeadSha256:'0'.repeat(64)},
  {...r,requestId:randomUUID()},{...r,quotaClaimed:false},{...r,responseHeadersAt:null},{...r,bodyBytes:0},
  {...r,observedAt:'2026-11-19T23:59:59.000Z'},{...r,observedAt:'2026-02-30T00:00:00.000Z'},
  {...r,command:{...outcome,retryAfterAt:'2026-11-20T00:00:60.000Z'}},{...r,command:{...outcome,code:null}},
  {...r,quotaPeriod:'day'},{...r,command:{...outcome,httpStatus:null,code:'connection_error'}}];
 for(const candidate of candidates)await expect(sql`INSERT INTO conditional_v2_transport_receipts(registration_id,request_id,reservation_operation_id,receipt_text)
  VALUES(${id}::uuid,${command.requestId}::uuid,${command.operationId}::uuid,${JSON.stringify(candidate)})`.execute(database.db)).rejects.toThrow();
 const duplicate=JSON.stringify(r).replace('"syntheticOnly":true','"syntheticOnly":true,"syntheticOnly":true');
 await expect(sql`INSERT INTO conditional_v2_transport_receipts(registration_id,request_id,reservation_operation_id,receipt_text)
  VALUES(${id}::uuid,${command.requestId}::uuid,${command.operationId}::uuid,${duplicate})`.execute(database.db)).rejects.toThrow();
 await sql`INSERT INTO conditional_v2_transport_receipts(registration_id,request_id,reservation_operation_id,receipt_text)
  VALUES(${id}::uuid,${command.requestId}::uuid,${command.operationId}::uuid,${JSON.stringify(r)})`.execute(database.db);
 await transport().finalize(owner,id,command.requestId);expect(hits).toBe(1);expect(await usage()).toBe(1);
});
it('lost completion acknowledgement is recovered exactly without a second wire request',async()=>{
 const worker=transport(),command=await input(),append=worker.journal.append.bind(worker.journal);
 worker.journal.append=async(...args:unknown[])=>{const result=await append(...args);if((args[4] as {kind:string}).kind==='complete')throw Error('synthetic lost completion acknowledgement');return result;};
 await expect(worker.execute(command)).rejects.toThrow('completion_pending_receipt_saved');expect(await count('conditional_collection_v2_events')).toBe(2);
 expect((await transport().finalize(owner,id,command.requestId)).operationStatus).toBe('already_recorded');expect(hits).toBe(1);expect(await usage()).toBe(1);
});
