import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {createServer,type ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sql} from '../dist/index.js';
import {ConditionalRealRegistrationStore} from '../../../tools/research/conditional-real-registration-store.mjs';
import {ConditionalCollectionJournal,collectionJournalPaths} from '../../../tools/research/conditional-collection-journal.mjs';
import {LocalConditionalCollectionTransport,collectionTransportPaths} from '../../../tools/research/conditional-collection-transport.mjs';
import {inspectRealRegistrationEnvironment,realSha} from '../../../tools/research/conditional-real-registration.mjs';
import {collectorFixture,map} from '../../../tests/fixtures/conditional-registered-collector.mjs';
let database:Awaited<ReturnType<typeof testDatabase>>,owner:string,id:string,packageSha:string,journal:ConditionalCollectionJournal;
let localOrigin:string,hits:number,paths:string[],handler:(res:ServerResponse)=>void;
const server=createServer((req,res)=>{hits++;paths.push(req.url!);expect(req.headers.authorization).toBeUndefined();handler(res);});
const at='2026-11-20T00:00:00.000Z';
async function clock(value:string){expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 await sql`CREATE OR REPLACE FUNCTION conditional_collection_clock() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS ${sql.lit(`SELECT '${value}'::timestamptz`)}`.execute(database.db);}
beforeAll(async()=>{
 database=await testDatabase();owner=(await sql<{id:string}>`INSERT INTO app_users(login,password_hash,account_role) VALUES('synthetic-transport-owner',${'x'.repeat(40)},'owner') RETURNING id`.execute(database.db)).rows[0]!.id;
 await sql`CREATE OR REPLACE FUNCTION conditional_real_registration_clock() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS ${sql.lit("SELECT '2026-11-15T01:00:00.000Z'::timestamptz")}`.execute(database.db);
 const f=await collectorFixture(owner);for(const path of [...collectionJournalPaths,...collectionTransportPaths])f.p.executable.code[path]=realSha(await readFile(path));
 f.p.executable.environmentText=await inspectRealRegistrationEnvironment();f.p.executable.environmentSha256=realSha(f.p.executable.environmentText);
 const text=JSON.stringify(f.p),r=await new ConditionalRealRegistrationStore(database.db).register(owner,text,realSha(text));id=r.id;packageSha=r.packageSha256;
 journal=new ConditionalCollectionJournal(database.db);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('test_server_address');
 localOrigin=`http://127.0.0.1:${address.port}`;
},60000);
beforeEach(async()=>{
 await database.db.transaction().execute(async tx=>{
  const tables=['conditional_transport_receipts','conditional_collection_events','conditional_collection_journals'];
  for(const table of tables)await sql`ALTER TABLE ${sql.id(table)} DISABLE TRIGGER USER`.execute(tx);
  await sql`TRUNCATE conditional_transport_receipts,conditional_collection_events,conditional_collection_journals`.execute(tx);
  for(const table of tables)await sql`ALTER TABLE ${sql.id(table)} ENABLE TRIGGER USER`.execute(tx);
  await sql`DELETE FROM provider_quotas`.execute(tx);
 });await clock(at);hits=0;paths=[];handler=res=>res.end(JSON.stringify([map()]));
},30000);
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await database?.close();},30000);
const transport=(options:object={})=>new LocalConditionalCollectionTransport(database.db,{localOrigin,...options});
async function input(syntheticOnly=true){let state=await journal.initialize(owner,id,packageSha,{syntheticOnly});
 state=await journal.append(owner,id,state.headSha256,randomUUID(),{kind:'scan',scanId:randomUUID()});
 return {ownerId:owner,registrationId:id,expectedHeadSha256:state.headSha256,operationId:randomUUID(),requestId:randomUUID(),endpoint:'/leagues/90001/matches'};}
async function receipt(){const row=(await sql<{receipt_text:string;receipt_sha256:string}>`SELECT receipt_text,receipt_sha256 FROM conditional_transport_receipts`.execute(database.db)).rows[0]!;
 expect(realSha(row.receipt_text)).toBe(row.receipt_sha256);return JSON.parse(row.receipt_text);}
async function usage(){return (await sql<{month_used:number}>`SELECT month_used FROM provider_quotas WHERE provider='opendota'`.execute(database.db)).rows[0]?.month_used??0;}

it('commits reserve, shared quota, raw response and timing receipt; restart finalization never sends again',async()=>{
 const command=await input(),done=await transport().execute(command);expect(done.status).toBe('completed');expect(done.state.report.observedPossibleMaps).toBe(1);
 expect(hits).toBe(1);expect(paths).toEqual(['/leagues/90001/matches']);expect(await usage()).toBe(1);
 const r=await receipt();expect(r.result.rawBody).toBe(JSON.stringify([map()]));expect(r.result.payloadSha256).toBe(realSha(r.result.rawBody));
 expect(r.syntheticOnly).toBe(true);expect(r.sendInvokedAt<=r.responseHeadersAt&&r.responseHeadersAt<=r.bodyCompletedAt).toBe(true);
 expect((await transport().finalize(owner,id,command.requestId)).operationStatus).toBe('already_recorded');
 expect((await transport().execute(command)).status).toBe('already_reserved');expect(hits).toBe(1);expect(await usage()).toBe(1);
});
it('concurrent identical retries send once and consume one quota claim',async()=>{
 const command=await input(),out=await Promise.all([transport().execute(command),transport().execute(command)]);
 expect(out.map(r=>r.status).sort()).toEqual(['already_reserved','completed']);expect(hits).toBe(1);expect(await usage()).toBe(1);
});
it('retains invalid JSON for audit and does not turn it into verified pro evidence',async()=>{
 handler=res=>res.end('{broken');const done=await transport().execute(await input());
 expect(done.state.report.attempts.invalidResponses).toBe(1);expect(done.state.report.verifiedProMaps).toBeNull();expect((await receipt()).result.rawBody).toBe('{broken');
});
it('honors 429 Retry-After in both durable journal and shared quota without hidden retry',async()=>{
 handler=res=>{res.writeHead(429,{'Retry-After':'60'});res.end('do not retain provider error pages');};
 const done=await transport().execute(await input());expect(hits).toBe(1);expect(await usage()).toBe(1);
 expect(done.state.report.cooldownUntil).toBe('2026-11-20T00:01:00.000Z');expect((await receipt()).httpStatus).toBe(429);
 const q=(await sql<{blocked:boolean}>`SELECT blocked_until>clock_timestamp() AS blocked FROM provider_quotas`.execute(database.db)).rows[0]!;expect(q.blocked).toBe(true);
});
it('shared quota exhaustion prevents HTTP but preserves the consumed collection reservation',async()=>{
 const worker=transport();await worker.quota.beforeRequest();await sql`UPDATE provider_quotas SET month_used=45000`.execute(database.db);
 const done=await worker.execute(await input());expect(hits).toBe(0);expect(done.state.report.attempts.total).toBe(1);
 expect((await receipt()).clientValidationCode).toBe('request_budget_exhausted');expect((await receipt()).sendInvokedAt).toBeNull();
});
it('aborts a stalled response body and records one timeout without retry',async()=>{
 handler=res=>{res.writeHead(200);res.write('[');};const done=await transport({timeoutMs:10000}).execute(await input());
 expect(hits).toBe(1);expect(done.state.report.attempts.failed).toBe(1);expect((await receipt()).clientValidationCode).toBe('source_timeout');
});
it('explicit cancellation before dispatch spends nothing',async()=>{
 const command=await input(),controller=new AbortController();controller.abort();await expect(transport().execute(command,{signal:controller.signal})).rejects.toThrow();
 expect(hits).toBe(0);expect(await usage()).toBe(0);expect((await journal.read(owner,id)).report.attempts.total).toBe(0);
});
it('rejects large bodies and invalid UTF-8 without saving truncated data as a captured response',async()=>{
 handler=res=>res.end('x'.repeat(100));await transport({maxResponseBytes:20}).execute(await input());
 expect((await receipt()).result).toMatchObject({status:'failed',code:'source_response_too_large'});expect((await receipt()).result.rawBody).toBeUndefined();
});
it('invalid UTF-8 fails explicitly',async()=>{
 handler=res=>res.end(Buffer.from([0xff]));await transport().execute(await input());expect((await receipt()).result.code).toBe('source_invalid_encoding');
});
it('does not follow a redirect or accept remote origins',async()=>{
 for(const value of ['https://api.opendota.com','http://localhost:5000','http://127.0.0.1:3000/path','http://user@127.0.0.1:3000'])expect(()=>transport({localOrigin:value})).toThrow();
 handler=res=>{res.writeHead(302,{Location:'https://api.opendota.com/api/proMatches'});res.end();};await transport().execute(await input());expect(hits).toBe(1);
 expect((await receipt()).result.status).toBe('failed');
});
it('rejects real journals and unauthorized identities before HTTP',async()=>{
 const command=await input(false);await expect(transport().execute(command)).rejects.toThrow('synthetic_transport_only');expect(hits).toBe(0);
 await expect(transport().execute({...command,ownerId:randomUUID()})).rejects.toThrow();expect(await usage()).toBe(0);
});
it('receipt survives completion rollback and finalizes after restart without refetch',async()=>{
 const command=await input();await sql`ALTER TABLE conditional_collection_events ADD CONSTRAINT synthetic_complete_failure CHECK(sequence<2)`.execute(database.db);
 try{await expect(transport().execute(command)).rejects.toThrow('transport_completion_pending_receipt_saved');expect((await receipt()).result.status).toBe('captured');}
 finally{await sql`ALTER TABLE conditional_collection_events DROP CONSTRAINT synthetic_complete_failure`.execute(database.db);}
 expect((await transport().execute(command)).status).toBe('already_reserved');await transport().finalize(owner,id,command.requestId);expect(hits).toBe(1);expect(await usage()).toBe(1);
});
it('receipt storage failure leaves unknown in-flight outcome and never resends an acknowledged reserve',async()=>{
 const command=await input();await sql`ALTER TABLE conditional_transport_receipts ADD CONSTRAINT synthetic_receipt_failure CHECK(false)`.execute(database.db);
 try{await expect(transport().execute(command)).rejects.toThrow('transport_receipt_persistence_unknown');}
 finally{await sql`ALTER TABLE conditional_transport_receipts DROP CONSTRAINT synthetic_receipt_failure`.execute(database.db);}
 expect((await journal.read(owner,id)).report.reasons).toContain('REQUEST_IN_FLIGHT');expect((await transport().execute(command)).status).toBe('already_reserved');expect(hits).toBe(1);
});
it('receipt refuses mutation; late finalization cannot replace recovery',async()=>{
 const command=await input();await sql`ALTER TABLE conditional_collection_events ADD CONSTRAINT synthetic_complete_failure CHECK(sequence<2)`.execute(database.db);
 try{await expect(transport().execute(command)).rejects.toThrow('transport_completion_pending_receipt_saved');}
 finally{await sql`ALTER TABLE conditional_collection_events DROP CONSTRAINT synthetic_complete_failure`.execute(database.db);}
 for(const query of [sql`UPDATE conditional_transport_receipts SET receipt_text=receipt_text`,sql`DELETE FROM conditional_transport_receipts`,sql`TRUNCATE conditional_transport_receipts`])await expect(query.execute(database.db)).rejects.toThrow('transport_receipt_immutable');
 await clock('2026-11-20T00:02:00.000Z');const state=await journal.read(owner,id);
 await journal.append(owner,id,state.headSha256,randomUUID(),{kind:'recover',requestId:command.requestId,reason:'Synthetic process recovery after an unknown completion outcome'});
 await expect(transport().finalize(owner,id,command.requestId)).rejects.toThrow('journal_head_conflict');expect(hits).toBe(1);
});
it('a reservation that became stale while waiting for quota is never dispatched',async()=>{
 const worker=transport(),claim=worker.quota.beforeRequest.bind(worker.quota);
 worker.quota.beforeRequest=async()=>{await claim();await clock('2026-11-20T00:00:30.000Z');};
 await worker.execute(await input());expect(hits).toBe(0);expect(await usage()).toBe(1);
 expect((await receipt()).result.code).toBe('transport_guard_failed');
});
it('lost reservation commit acknowledgement never grants a dispatch on retry',async()=>{
 const command=await input(),worker=transport(),append=worker.journal.append.bind(worker.journal);
 worker.journal.append=async(...args:unknown[])=>{await append(...args);throw Error('synthetic lost commit acknowledgement');};
 await expect(worker.execute(command)).rejects.toThrow('synthetic lost commit acknowledgement');
 expect((await transport().execute(command)).status).toBe('already_reserved');expect(hits).toBe(0);expect(await usage()).toBe(0);
 expect((await journal.read(owner,id)).report.attempts.total).toBe(1);
});
it('cancellation during a streaming response stops reading and records a cancelled attempt',async()=>{
 const controller=new AbortController();handler=res=>{res.writeHead(200);res.write('[');controller.abort();};
 await transport().execute(await input(),{signal:controller.signal});expect(hits).toBe(1);
 expect((await receipt()).result.code).toBe('transport_cancelled');
});
it('quota observation failure remains explicit in the durable receipt',async()=>{
 const worker=transport();worker.quota.observe=async()=>{throw Error('synthetic DB failure');};
 const done=await worker.execute(await input());expect(done.quotaObservationFailed).toBe(true);
 expect((await receipt()).quotaObservationFailed).toBe(true);expect((await receipt()).result.status).toBe('captured');expect(hits).toBe(1);
});
it('dispatches discovered BIGINT details and the global decreasing cursor through the named client',async()=>{
 const command=await input();let result=await transport().execute(command);
 const next=async(endpoint:string,body:unknown)=>{
  handler=res=>res.end(JSON.stringify(body));
  result=await transport().execute({...command,endpoint,expectedHeadSha256:result.state.headSha256,operationId:randomUUID(),requestId:randomUUID()});
 };
 await next('/matches/9007199254741201',map());expect(result.state.report.maps[0].detailCaptured).toBe(true);
 await next('/proMatches',[map('9007199254741200')]);
 await next('/proMatches?less_than_match_id=9007199254741200',[]);
 expect(paths).toEqual(['/leagues/90001/matches','/matches/9007199254741201','/proMatches','/proMatches?less_than_match_id=9007199254741200']);
 expect(result.state.report.attempts.total).toBe(4);expect(await usage()).toBe(4);expect(result.state.report.denominatorComplete).toBe(false);
},60000);
