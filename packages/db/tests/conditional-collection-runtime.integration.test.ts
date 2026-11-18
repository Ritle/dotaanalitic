import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {createServer,type ServerResponse} from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sql} from '../dist/index.js';
import {ConditionalRealRegistrationStore} from '../../../tools/research/conditional-real-registration-store.mjs';
import {ConditionalCollectionJournal} from '../../../tools/research/conditional-collection-journal.mjs';
import {LocalConditionalCollectionTransport} from '../../../tools/research/conditional-collection-transport.mjs';
import {LocalConditionalCollectionRuntime,collectionRuntimeManifestPaths,verifyCollectionRuntimeManifest,collectionHasResponseCapacity} from '../../../tools/research/conditional-collection-runtime.mjs';
import {inspectRealRegistrationEnvironment,realSha} from '../../../tools/research/conditional-real-registration.mjs';
import {collectorFixture,map} from '../../../tests/fixtures/conditional-registered-collector.mjs';
let database:Awaited<ReturnType<typeof testDatabase>>,owner:string,id:string,packageSha:string,journal:ConditionalCollectionJournal;
let localOrigin:string,paths:string[],handler:(path:string,res:ServerResponse)=>void,fixtureDir:string;
const server=createServer((req,res)=>{paths.push(req.url!);handler(req.url!,res);});
const at='2026-11-20T00:00:00.000Z';
async function clock(value:string){expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 await sql`CREATE OR REPLACE FUNCTION conditional_collection_clock() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS ${sql.lit(`SELECT '${value}'::timestamptz`)}`.execute(database.db);}
beforeAll(async()=>{
 database=await testDatabase();owner=(await sql<{id:string}>`INSERT INTO app_users(login,password_hash,account_role) VALUES('synthetic-runtime-owner',${'x'.repeat(40)},'owner') RETURNING id`.execute(database.db)).rows[0]!.id;
 await sql`CREATE OR REPLACE FUNCTION conditional_real_registration_clock() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS ${sql.lit("SELECT '2026-11-15T01:00:00.000Z'::timestamptz")}`.execute(database.db);
 const f=await collectorFixture(owner);for(const path of await collectionRuntimeManifestPaths())f.p.executable.code[path]=realSha(await readFile(path));
 f.p.executable.environmentText=await inspectRealRegistrationEnvironment();f.p.executable.environmentSha256=realSha(f.p.executable.environmentText);
 const text=JSON.stringify(f.p),r=await new ConditionalRealRegistrationStore(database.db).register(owner,text,realSha(text));id=r.id;packageSha=r.packageSha256;
 journal=new ConditionalCollectionJournal(database.db);fixtureDir=await mkdtemp(join(resolve('.tools'),'collection-runtime-fixture-'));
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw Error('test_server_address');
 localOrigin=`http://127.0.0.1:${address.port}`;
},90000);
beforeEach(async()=>{
 await database.db.transaction().execute(async tx=>{
  const tables=['conditional_transport_receipts','conditional_collection_events','conditional_collection_journals'];
  for(const table of tables)await sql`ALTER TABLE ${sql.id(table)} DISABLE TRIGGER USER`.execute(tx);
  await sql`TRUNCATE conditional_transport_receipts,conditional_collection_events,conditional_collection_journals`.execute(tx);
  for(const table of tables)await sql`ALTER TABLE ${sql.id(table)} ENABLE TRIGGER USER`.execute(tx);
  await sql`DELETE FROM provider_quotas`.execute(tx);
 });await clock(at);paths=[];handler=(path,res)=>res.end(JSON.stringify(path==='/leagues/90001/matches'?[map()]:path.startsWith('/matches/')?map():[]));
},30000);
afterAll(async()=>{
 server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await database?.close();
 if(fixtureDir){expect(resolve(fixtureDir).startsWith(resolve('.tools')+sep+'collection-runtime-fixture-')).toBe(true);await rm(fixtureDir,{recursive:true,force:true});}
},30000);
const request=(options:object={})=>({mode:'local-synthetic',ownerId:owner,registrationId:id,registrationSha256:packageSha,localOrigin,...options});
const run=(options:object={})=>new LocalConditionalCollectionRuntime(database.db).run(request(options));
async function pending(){let state=await journal.initialize(owner,id,packageSha,{syntheticOnly:true});
 state=await journal.append(owner,id,state.headSha256,randomUUID(),{kind:'scan',scanId:randomUUID()});
 const requestId=randomUUID();state=await journal.append(owner,id,state.headSha256,randomUUID(),{kind:'reserve',requestId,endpoint:'/leagues/90001/matches'});return {state,requestId};}
async function unfinishedReceipt(quotaFailure=false){let state=await journal.initialize(owner,id,packageSha,{syntheticOnly:true});
 state=await journal.append(owner,id,state.headSha256,randomUUID(),{kind:'scan',scanId:randomUUID()});
 const worker=new LocalConditionalCollectionTransport(database.db,{localOrigin});
 if(quotaFailure)worker.quota.observe=async()=>{throw Error('synthetic secret quota error');};
 await sql`ALTER TABLE conditional_collection_events ADD CONSTRAINT runtime_synthetic_failure CHECK(sequence<2)`.execute(database.db);
 try{await expect(worker.execute({ownerId:owner,registrationId:id,expectedHeadSha256:state.headSha256,operationId:randomUUID(),requestId:randomUUID(),endpoint:'/leagues/90001/matches'})).rejects.toThrow('transport_completion_pending_receipt_saved');}
 finally{await sql`ALTER TABLE conditional_collection_events DROP CONSTRAINT runtime_synthetic_failure`.execute(database.db);}
}
async function cli(payload:object,connection=database.url){
 const path=join(fixtureDir,randomUUID()+'.json');await writeFile(path,JSON.stringify(payload));
 return new Promise<{code:number|null;stdout:string;stderr:string}>((done,reject)=>{
  const child=spawn(process.execPath,['tools/research/run-conditional-collection.mjs','--request',path],{cwd:process.cwd(),windowsHide:true,env:{...process.env,DATABASE_URL:connection}});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>done({code,stdout,stderr}));
 });
}

it('runs one complete scan, retaining all maps and no scoring permission',async()=>{
 const r=await run();expect(r).toMatchObject({status:'complete',reason:'scan_complete_not_denominator_verified',reservationsAcknowledgedThisRun:4,
  attemptsObservedTotal:4,observedPossibleMaps:1,denominatorComplete:false,remoteCollectionAllowed:false,deployable:false});
 expect(paths).toEqual(['/leagues/90001/matches','/leagues/90002/matches','/matches/9007199254741201','/proMatches']);
 expect(JSON.stringify(r)).not.toContain('rawBody');
},60000);
it('request limit resumes the same scan across fresh runtime instances without repeating pages',async()=>{
 expect((await run({maxRequests:1})).reason).toBe('run_request_limit');
 const r=await run();expect(r.status).toBe('complete');expect(r.attemptsObservedTotal).toBe(4);expect(paths.filter(p=>p==='/leagues/90001/matches')).toHaveLength(1);
 expect((await journal.read(owner,id)).report.scans).toHaveLength(1);
},60000);
it('finalizes a retained receipt after restart before issuing another request',async()=>{
 await unfinishedReceipt();const r=await run();expect(r.responsesResumedThisRun).toBe(1);expect(r.status).toBe('complete');expect(paths.filter(p=>p==='/leagues/90001/matches')).toHaveLength(1);
},60000);
it('does not resend or automatically recover an expired unknown in-flight request',async()=>{
 await pending();await clock('2026-11-20T00:03:00.000Z');expect(await run()).toMatchObject({status:'blocked',reason:'inflight_outcome_unknown',attemptsObservedTotal:1});expect(paths).toEqual([]);
 expect((await journal.read(owner,id)).report.reasons).toContain('REQUEST_IN_FLIGHT');
});
it('quota observation failure remains a stop across restarts, while the saved receipt is finalized',async()=>{
 await unfinishedReceipt(true);const r=await run();expect(r.responsesResumedThisRun).toBe(1);expect(r.reason).toBe('quota_observation_failed');
 expect((await run()).reason).toBe('quota_observation_failed');expect(paths).toHaveLength(1);
},60000);
it('429 stops the run and retry during cooldown does not consume another attempt',async()=>{
 handler=(_path,res)=>{res.writeHead(429,{'Retry-After':'60'});res.end();};
 expect((await run()).reason).toBe('transport_attempt_failed');const r=await run();expect(r.reason).toBe('retry_after');expect(r.attemptsObservedTotal).toBe(1);expect(paths).toHaveLength(1);
},60000);
it('invalid data stops before another endpoint and stays blocked on restart',async()=>{
 handler=(_path,res)=>res.end('{not-json');expect((await run()).reason).toBe('invalid_source_response');expect((await run()).reason).toBe('invalid_source_response');expect(paths).toHaveLength(1);
},60000);
it('does not initialize before the window and never dispatches after closing',async()=>{
 await clock('2026-11-19T00:00:00.000Z');expect((await run()).reason).toBe('collection_not_started');
 expect((await sql<{n:string}>`SELECT count(*)::text AS n FROM conditional_collection_journals`.execute(database.db)).rows[0]!.n).toBe('0');
 await clock('2026-12-25T00:00:00.000Z');expect((await run()).reason).toBe('collection_window_closed');expect(paths).toHaveLength(0);
},60000);
it('concurrent runner returns busy and does not take over an active connection lock',async()=>{
 await database.db.connection().execute(async c=>{
  const key='conditional-runtime:'+id;await sql`SELECT pg_advisory_lock(hashtextextended(${key},0))`.execute(c);
  try{expect((await run()).status).toBe('busy');expect(paths).toHaveLength(0);}
  finally{await sql`SELECT pg_advisory_unlock(hashtextextended(${key},0))`.execute(c);}
 });expect((await run({maxRequests:1})).reason).toBe('run_request_limit');
},60000);
it('time budget cancels a streaming response and releases the runtime lock',async()=>{
 handler=(_path,res)=>{res.writeHead(200);res.write('[');};
 const r=await run({maxDurationMs:10000});expect(['transport_attempt_failed','run_duration_limit']).toContain(r.reason);expect(paths).toHaveLength(1);
 expect((await run()).status).not.toBe('busy');
},60000);
it('explicit cancellation before the run causes no dispatch or journal mutation',async()=>{
 const controller=new AbortController();controller.abort();const r=await new LocalConditionalCollectionRuntime(database.db).run(request(),{signal:controller.signal});
 expect(r.reason).toBe('cancelled');expect(paths).toEqual([]);
});
it('newScan refuses to reset an incomplete scan, while completed scans need an explicit refresh',async()=>{
 await run({maxRequests:1});expect((await run({newScan:true})).reason).toBe('unfinished_scan_cannot_reset');await run();
 const count=paths.length;expect((await run()).status).toBe('complete');expect(paths).toHaveLength(count);
 expect((await run({newScan:true,maxRequests:1})).reason).toBe('run_request_limit');expect(paths.length).toBe(count+1);
},90000);
it('manifest requires the runner, CLI and workspace dependency closure',async()=>{
 const r=await journal.registration(owner,id),p=JSON.parse(r.packageText);delete p.executable.code['packages/db/dist/index.js'];
 await expect(verifyCollectionRuntimeManifest({...r,packageText:JSON.stringify(p)})).rejects.toThrow('runtime_manifest_incomplete');
 p.executable.code['packages/db/dist/index.js']='0'.repeat(64);
 await expect(verifyCollectionRuntimeManifest({...r,packageText:JSON.stringify(p)})).rejects.toThrow('runtime_code_changed');expect(paths).toHaveLength(0);
});
it('refuses foreign owner, changed registration hash, remote mode and caller ready flags',async()=>{
 for(const options of [{ownerId:randomUUID()},{registrationSha256:'0'.repeat(64)},{mode:'remote'},{localOrigin:'https://api.opendota.com'},{collectionAllowed:true}])await expect(run(options)).rejects.toThrow();
 expect(paths).toHaveLength(0);
});
it('capacity guard reserves space for the worst-case escaped response before sending',()=>{
 const boundary=67108864-6*1048576-65536;
 expect(collectionHasResponseCapacity(0)).toBe(true);expect(collectionHasResponseCapacity(boundary)).toBe(true);
 expect(collectionHasResponseCapacity(boundary+1)).toBe(false);expect(()=>collectionHasResponseCapacity(-1)).toThrow();
});
it('finalizes saved evidence after the window closes without making a new request',async()=>{
 await unfinishedReceipt();await clock('2026-12-25T00:00:00.000Z');
 const r=await run();expect(r).toMatchObject({responsesResumedThisRun:1,status:'stopped',reason:'collection_window_closed'});expect(paths).toHaveLength(1);
 expect((await journal.read(owner,id)).report.requests[0].status).toBe('captured');
});
it('detects a corrupted receipt before any further dispatch',async()=>{
 await run({maxRequests:1});await database.db.transaction().execute(async tx=>{
  await sql`ALTER TABLE conditional_transport_receipts DISABLE TRIGGER USER`.execute(tx);
  await sql`UPDATE conditional_transport_receipts SET receipt_sha256=${'0'.repeat(64)}`.execute(tx);
  await sql`ALTER TABLE conditional_transport_receipts ENABLE TRIGGER USER`.execute(tx);
 });
 expect(await run()).toMatchObject({status:'blocked',reason:'runtime_step_failed_inspect_journal',headSha256:null});expect(paths).toHaveLength(1);
});
it('CLI runs only against a disposable local DB, emits a compact report, and rejects secrets without echoing them',async()=>{
 const r=await cli(request({maxRequests:1}));expect(r.code).toBe(0);expect(JSON.parse(r.stdout)).toMatchObject({reason:'run_request_limit',attemptsObservedTotal:1});
 const rejected=await cli({...request(),mode:'remote',apiKey:'synthetic-private-secret'});expect(rejected.code).toBe(1);expect(rejected.stderr).not.toContain('synthetic-private-secret');
 const working=new URL(database.url);working.pathname='/owner_working_database';working.username='synthetic-owner';working.password='synthetic-db-secret';
 const denied=await cli(request(),working.toString());expect(denied.code).toBe(1);expect(denied.stderr).not.toContain('synthetic-db-secret');
 expect(paths).toHaveLength(1);
},60000);
