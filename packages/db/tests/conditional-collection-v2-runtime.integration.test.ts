import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer,type ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import {testDatabase} from '../../../tests/helpers/postgres.js';
import {sql} from '../dist/index.js';
import {ConditionalRegistrationV2Store} from '../../../tools/research/conditional-real-registration-v2-store.mjs';
import {ConditionalCollectionV2Journal} from '../../../tools/research/conditional-collection-v2-journal.mjs';
import {LocalConditionalCollectionV2Transport} from '../../../tools/research/conditional-collection-v2-transport.mjs';
import {LocalConditionalCollectionV2Runtime,collectionV2RuntimeManifestPaths,verifyCollectionV2RuntimeManifest} from '../../../tools/research/conditional-collection-v2-runtime.mjs';
import {archiveSha as sha} from '../../../tools/research/conditional-blob-archive.mjs';
import {inspectRealRegistrationEnvironment} from '../../../tools/research/conditional-real-registration.mjs';
import {registrationV2Fixture} from '../../../tests/fixtures/conditional-registration-v2.mjs';
import {map} from '../../../tests/fixtures/conditional-registered-collector.mjs';
let database:Awaited<ReturnType<typeof testDatabase>>,owner:string,id:string,packageSha:string,journal:ConditionalCollectionV2Journal;
let localOrigin:string,paths:string[],handler:(path:string,res:ServerResponse)=>void,fixtureDir:string;
const at='2026-12-04T00:00:00.000Z';
const tables=['conditional_v2_transport_receipts','conditional_collection_v2_events','conditional_collection_v2_journals','conditional_blob_entries','conditional_blob_receipts','conditional_raw_blobs','conditional_blob_archives'];
// Remove fixture-only spacing to test orchestration independently of machine speed; quota counts/429 remain real.
const server=createServer((req,res)=>{paths.push(req.url!);expect(req.headers.authorization).toBeUndefined();
 void sql`UPDATE provider_quotas SET next_request_at='-infinity' WHERE provider='opendota'`.execute(database.db)
  .then(()=>handler(req.url!,res)).catch(()=>res.destroy());});
async function clock(value:string){expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 for(const name of ['conditional_real_registration_clock','conditional_collection_clock'])
  await sql`CREATE OR REPLACE FUNCTION ${sql.id(name)}() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS ${sql.lit(`SELECT '${value}'::timestamptz`)}`.execute(database.db);}
beforeAll(async()=>{
 database=await testDatabase();journal=new ConditionalCollectionV2Journal(database.db);
 owner=(await sql<{id:string}>`INSERT INTO app_users(login,password_hash,account_role) VALUES('synthetic-v2-runtime-owner',${'x'.repeat(40)},'owner') RETURNING id`.execute(database.db)).rows[0]!.id;
 await sql`CREATE OR REPLACE FUNCTION conditional_real_registration_clock() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS ${sql.lit("SELECT '2026-11-15T01:00:00.000Z'::timestamptz")}`.execute(database.db);
 const p=await registrationV2Fixture(owner);p.executable.environmentText=await inspectRealRegistrationEnvironment();p.executable.environmentSha256=sha(p.executable.environmentText);
 for(const path of await collectionV2RuntimeManifestPaths())p.executable.code[path]=sha(await readFile(path));
 const text=JSON.stringify(p),r=await new ConditionalRegistrationV2Store(database.db).register(owner,text,sha(text));id=r.id;packageSha=r.packageSha256;
 fixtureDir=await mkdtemp(join(resolve('.tools'),'v2-runtime-fixture-'));
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw Error('test_server');localOrigin=`http://127.0.0.1:${address.port}`;
},90000);
beforeEach(async()=>{
 await database.db.transaction().execute(async tx=>{for(const t of tables)await sql`ALTER TABLE ${sql.id(t)} DISABLE TRIGGER USER`.execute(tx);
  await sql`TRUNCATE conditional_v2_transport_receipts,conditional_collection_v2_events,conditional_collection_v2_journals,conditional_blob_entries,conditional_blob_receipts,conditional_raw_blobs,conditional_blob_archives`.execute(tx);
  for(const t of tables)await sql`ALTER TABLE ${sql.id(t)} ENABLE TRIGGER USER`.execute(tx);
  await sql`DELETE FROM provider_quotas`.execute(tx);await sql`UPDATE app_users SET account_role='owner',is_active=true WHERE id=${owner}::uuid`.execute(tx);
 });await clock(at);paths=[];handler=(path,res)=>res.end(JSON.stringify(path==='/leagues/90001/matches'?[map()]:path.startsWith('/matches/')?map():[]));
});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await database?.close();
 if(fixtureDir){expect(resolve(fixtureDir).startsWith(resolve('.tools')+sep+'v2-runtime-fixture-')).toBe(true);await rm(fixtureDir,{recursive:true,force:true});}
},30000);
const request=(options:object={})=>({mode:'local-synthetic',ownerId:owner,registrationId:id,registrationSha256:packageSha,localOrigin,...options});
const run=(options:object={})=>new LocalConditionalCollectionV2Runtime(database.db).run(request(options));
async function initialize(maxBytes=64*1024*1024){return journal.initialize(owner,id,packageSha,{syntheticOnly:true,maxBytes});}
async function unfinishedReceipt(quotaFailure=false){const state=await initialize(),worker=new LocalConditionalCollectionV2Transport(database.db,{localOrigin});
 if(quotaFailure)worker.quota.observe=async()=>{throw Error('synthetic-secret-quota');};
 await sql`ALTER TABLE conditional_collection_v2_events ADD CONSTRAINT runtime_v2_synthetic_failure CHECK(sequence<1)`.execute(database.db);
 try{await expect(worker.execute({ownerId:owner,registrationId:id,expectedHeadSha256:state.headSha256,operationId:randomUUID(),requestId:randomUUID(),endpoint:'/leagues/90001/matches'})).rejects.toThrow('completion_pending_receipt_saved');}
 finally{await sql`ALTER TABLE conditional_collection_v2_events DROP CONSTRAINT runtime_v2_synthetic_failure`.execute(database.db);}
}
async function count(table:string){return Number((await sql`SELECT count(*) AS n FROM ${sql.id(table)}`.execute(database.db)).rows[0]!.n);}
async function cli(payload:object,connection=database.url){const path=join(fixtureDir,randomUUID()+'.json');await writeFile(path,JSON.stringify(payload));
 return new Promise<{code:number|null;stdout:string;stderr:string}>((done,reject)=>{const child=spawn(process.execPath,['tools/research/run-conditional-collection-v2.mjs','--request',path],
  {cwd:process.cwd(),windowsHide:true,env:{...process.env,DATABASE_URL:connection}});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  child.on('error',reject);child.on('close',code=>done({code,stdout,stderr}));});}
it('performs the complete discovery/detail sweep with one request per endpoint and no scoring authority',async()=>{
 const r=await run();expect(r).toMatchObject({status:'complete',reason:'sweep_complete_not_denominator_verified',reservationsAcknowledgedThisRun:4,
  dispatchesAcknowledgedThisRun:4,attemptsObservedTotal:4,observedPossibleMaps:1,denominatorComplete:false,deployable:false});
 expect(paths).toEqual(['/leagues/90001/matches','/leagues/90002/matches','/matches/9007199254741201','/proMatches']);
 const before=[...paths];expect((await run()).status).toBe('complete');expect(paths).toEqual(before);expect(JSON.stringify(r)).not.toContain('rawBody');
},90000);
it('request limit persists progress and later invocation resumes without repeating the first response',async()=>{
 const a=await run({maxRequests:1});expect(a.reason).toBe('run_request_limit');expect(a.reservationsAcknowledgedThisRun).toBe(1);
 const b=await run();expect(b.status).toBe('complete');expect(b.reservationsAcknowledgedThisRun).toBe(3);expect(paths.filter(p=>p==='/leagues/90001/matches')).toHaveLength(1);
},90000);
it('before window and closed empty window create no archive and send no HTTP',async()=>{
 for(const value of ['2026-11-19T23:59:59.000Z','2026-12-25T00:00:00.000Z']){await clock(value);expect((await run()).status).toBe('stopped');expect(await count('conditional_blob_archives')).toBe(0);}
 expect(paths).toHaveLength(0);
});
it('already cancelled and expired duration do not initialize or dispatch',async()=>{
 const c=new AbortController();c.abort();expect((await new LocalConditionalCollectionV2Runtime(database.db).run(request(),{signal:c.signal})).reason).toBe('cancelled');
 const service=new LocalConditionalCollectionV2Runtime(database.db),read=service.journal.registration.bind(service.journal);
 service.journal.registration=async(...args:unknown[])=>{await new Promise(done=>setTimeout(done,150));return read(...args);};
 expect((await service.run(request({maxDurationMs:100}))).reason).toBe('run_duration_limit');expect(paths).toHaveLength(0);expect(await count('conditional_blob_archives')).toBe(0);
});
it('a concurrent session lock returns busy and is never released by the losing caller',async()=>{
 await database.db.connection().execute(async connection=>{const key='conditional-runtime-v2:'+id;await sql`SELECT pg_advisory_lock(hashtextextended(${key},0))`.execute(connection);
  try{expect((await run()).status).toBe('busy');expect(paths).toHaveLength(0);}finally{await sql`SELECT pg_advisory_unlock(hashtextextended(${key},0))`.execute(connection);}});
 expect((await run({maxRequests:1})).reason).toBe('run_request_limit');
});
it('pending reservation without receipt blocks and is never blindly resent',async()=>{
 const h=await initialize();await journal.append(owner,id,h.headSha256,randomUUID(),{kind:'reserve',requestId:randomUUID(),endpoint:'/leagues/90001/matches'});
 expect((await run()).reason).toBe('inflight_outcome_unknown');expect(paths).toHaveLength(0);expect((await journal.read(owner,id)).attempts.total).toBe(1);
});
it('recovers a durable receipt after collection cutoff without another HTTP request',async()=>{
 await unfinishedReceipt();expect(paths).toHaveLength(1);await clock('2026-12-25T00:00:00.000Z');
 const r=await run();expect(r.responsesResumedThisRun).toBe(1);expect(r.reason).toBe('collection_window_closed');expect(paths).toHaveLength(1);
 expect((await journal.read(owner,id)).pendingRequest).toBeNull();
});
it('quota-observation failure can finalize retained bytes but blocks all new dispatch',async()=>{
 await unfinishedReceipt(true);const r=await run();expect(r.responsesResumedThisRun).toBe(1);expect(r.reason).toBe('quota_observation_failed');expect(paths).toHaveLength(1);
 expect(JSON.stringify(r)).not.toContain('synthetic-secret');expect((await run()).reason).toBe('quota_observation_failed');expect(paths).toHaveLength(1);
});
it('429 Retry-After survives restart and is not retried in the same invocation',async()=>{
 handler=(_path,res)=>{res.writeHead(429,{'retry-after':'60'});res.end();};expect((await run()).reason).toBe('transport_attempt_failed');
 expect((await run()).reason).toBe('retry_after');expect(paths).toHaveLength(1);
});
it('invalid duplicate discovery rows stop the runtime before another endpoint is requested',async()=>{
 handler=(_path,res)=>res.end(JSON.stringify([map(),map()]));const r=await run();expect(r.reason).toBe('invalid_source_response');expect(paths).toHaveLength(1);
 expect((await run()).reason).toBe('invalid_source_response');expect(paths).toHaveLength(1);
});
it('low archive capacity does not consume a new reservation or provider quota',async()=>{
 await initialize(1024);expect((await run()).reason).toBe('archive_capacity_low');expect(paths).toHaveLength(0);
 expect((await journal.read(owner,id)).attempts.total).toBe(0);expect(await count('provider_quotas')).toBe(0);
});
it('uncertain persistence stops with sanitized output and a later invocation does not resend',async()=>{
 await sql`ALTER TABLE conditional_v2_transport_receipts ADD CONSTRAINT runtime_v2_receipt_failure CHECK(false)`.execute(database.db);
 try{const r=await run();expect(r.reason).toBe('runtime_step_failed_inspect_journal');expect(r.countsComplete).toBe(false);expect(r.journalHeadSha256).toBeNull();}
 finally{await sql`ALTER TABLE conditional_v2_transport_receipts DROP CONSTRAINT runtime_v2_receipt_failure`.execute(database.db);}
 expect((await run()).reason).toBe('inflight_outcome_unknown');expect(paths).toHaveLength(1);expect(await count('conditional_raw_blobs')).toBe(0);
});
it('manifest drift or missing dependency rejects before dispatch',async()=>{
 const r=await journal.registration(owner,id),p=JSON.parse(r.packageText);delete p.executable.code['packages/contracts/dist/index.js'];
 await expect(verifyCollectionV2RuntimeManifest({...r,packageText:JSON.stringify(p)})).rejects.toThrow();
 const other=JSON.parse(r.packageText);other.executable.code['packages/contracts/dist/index.js']='0'.repeat(64);
 await expect(verifyCollectionV2RuntimeManifest({...r,packageText:JSON.stringify(other)})).rejects.toThrow('runtime_code_changed');expect(paths).toHaveLength(0);
});
it('CLI resumes bounded local work but refuses production DB, remote origins and unknown flags without exposing secrets',async()=>{
 const ok=await cli(request({maxRequests:1}));expect(ok.code).toBe(0);expect(JSON.parse(ok.stdout).reason).toBe('run_request_limit');
 for(const [payload,url] of [[request(),'postgresql://secret:do-not-print@127.0.0.1/production'],[request({localOrigin:'https://api.opendota.com?api_key=do-not-print'}),database.url],
  [request({apiKey:'do-not-print'}),database.url]] as const){const bad=await cli(payload,url);expect(bad.code).toBe(1);expect(bad.stdout+bad.stderr).not.toContain('do-not-print');}
 expect(paths).toHaveLength(1);
},90000);
it('cancellation while HTTP is in flight records the attempt and releases the runner lock',async()=>{
 const c=new AbortController();handler=(_path,res)=>{res.writeHead(200);res.write('[');c.abort();res.end();};
 const r=await new LocalConditionalCollectionV2Runtime(database.db).run(request(),{signal:c.signal});expect(r.reason).toBe('cancelled');expect(paths).toHaveLength(1);
 expect((await journal.read(owner,id)).pendingRequest).toBeNull();expect((await run()).reason).toBe('retry_after');expect(paths).toHaveLength(1);
});
it('saved successful receipt resumes normal traversal without refetching the first endpoint',async()=>{
 await unfinishedReceipt();const r=await run();expect(r.responsesResumedThisRun).toBe(1);expect(r.status).toBe('complete');
 expect(r.reservationsAcknowledgedThisRun).toBe(3);expect(paths.filter(p=>p==='/leagues/90001/matches')).toHaveLength(1);
},90000);
it('301 observed targets stop before any detail or next league request',async()=>{
 handler=(_path,res)=>res.end(JSON.stringify(Array.from({length:301},(_,i)=>map(String(9007199254741201n+BigInt(i))))));
 const r=await run();expect(r.reason).toBe('target_budget_exceeded');expect(r.observedPossibleMaps).toBe(301);expect(paths).toHaveLength(1);
});
it('inactive owner or mismatched registration hash never initialize collection',async()=>{
 expect((await run({registrationSha256:'0'.repeat(64)})).status).toBe('blocked');
 await sql`UPDATE app_users SET is_active=false WHERE id=${owner}::uuid`.execute(database.db);expect((await run()).status).toBe('blocked');
 expect(paths).toHaveLength(0);expect(await count('conditional_blob_archives')).toBe(0);
});
