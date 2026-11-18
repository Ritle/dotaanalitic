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
import {LocalConditionalCollectionV2Runtime} from '../../../tools/research/conditional-collection-v2-runtime.mjs';
import {LocalConditionalCollectionV2RefreshRuntime,ConditionalCollectionV2RefreshDiscovery,collectionV2RefreshManifestPaths,verifyCollectionV2RefreshManifest} from '../../../tools/research/conditional-collection-v2-refresh.mjs';
import {archiveSha as sha} from '../../../tools/research/conditional-blob-archive.mjs';
import {inspectRealRegistrationEnvironment} from '../../../tools/research/conditional-real-registration.mjs';
import {registrationV2Fixture} from '../../../tests/fixtures/conditional-registration-v2.mjs';
import {map} from '../../../tests/fixtures/conditional-registered-collector.mjs';
let database:Awaited<ReturnType<typeof testDatabase>>,owner:string,id:string,packageSha:string,journal:ConditionalCollectionV2Journal;
let localOrigin:string,paths:string[],handler:(path:string,res:ServerResponse)=>void,fixtureDir:string;
const tables=['conditional_collection_v2_sweeps','conditional_v2_transport_receipts','conditional_collection_v2_events','conditional_collection_v2_journals','conditional_blob_entries','conditional_blob_receipts','conditional_raw_blobs','conditional_blob_archives'];
// Synthetic server only: bypass request spacing, retaining counters, cooldown and Retry-After.
const server=createServer((req,res)=>{paths.push(req.url!);expect(req.headers.authorization).toBeUndefined();
 void sql`UPDATE provider_quotas SET next_request_at='-infinity' WHERE provider='opendota'`.execute(database.db)
 .then(()=>handler(req.url!,res)).catch(()=>res.destroy());});
async function clock(value:string){expect(new URL(database.url).pathname).toMatch(/^\/codex_ingest_[a-f0-9]{12}$/);
 for(const name of ['conditional_real_registration_clock','conditional_collection_clock'])
 await sql`CREATE OR REPLACE FUNCTION ${sql.id(name)}() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS ${sql.lit(`SELECT '${value}'::timestamptz`)}`.execute(database.db);}
beforeAll(async()=>{
 database=await testDatabase();journal=new ConditionalCollectionV2Journal(database.db);
 owner=(await sql<{id:string}>`INSERT INTO app_users(login,password_hash,account_role) VALUES('synthetic-refresh-owner',${'x'.repeat(40)},'owner') RETURNING id`.execute(database.db)).rows[0]!.id;
 await clock('2026-11-15T01:00:00.000Z');const p=await registrationV2Fixture(owner);
 p.executable.environmentText=await inspectRealRegistrationEnvironment();p.executable.environmentSha256=sha(p.executable.environmentText);
 for(const path of await collectionV2RefreshManifestPaths())p.executable.code[path]=sha(await readFile(path));
 const text=JSON.stringify(p),r=await new ConditionalRegistrationV2Store(database.db).register(owner,text,sha(text));id=r.id;packageSha=r.packageSha256;
 fixtureDir=await mkdtemp(join(resolve('.tools'),'v2-refresh-fixture-'));
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw Error('test_server');localOrigin=`http://127.0.0.1:${address.port}`;
},90000);
beforeEach(async()=>{
 await database.db.transaction().execute(async tx=>{for(const t of tables)await sql`ALTER TABLE ${sql.id(t)} DISABLE TRIGGER USER`.execute(tx);
  await sql`TRUNCATE conditional_collection_v2_sweeps,conditional_v2_transport_receipts,conditional_collection_v2_events,conditional_collection_v2_journals,conditional_blob_entries,conditional_blob_receipts,conditional_raw_blobs,conditional_blob_archives`.execute(tx);
  for(const t of tables)await sql`ALTER TABLE ${sql.id(t)} ENABLE TRIGGER USER`.execute(tx);
  await sql`DELETE FROM provider_quotas`.execute(tx);await sql`UPDATE app_users SET account_role='owner',is_active=true WHERE id=${owner}::uuid`.execute(tx);
 });await clock('2026-12-04T00:00:00.000Z');paths=[];
 handler=(path,res)=>res.end(JSON.stringify(path==='/leagues/90001/matches'?[map()]:path.startsWith('/matches/')?map():[]));
},30000);
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await database?.close();
 if(fixtureDir){expect(resolve(fixtureDir).startsWith(resolve('.tools')+sep+'v2-refresh-fixture-')).toBe(true);await rm(fixtureDir,{recursive:true,force:true});}
},30000);
const request=(options:object={})=>({mode:'local-synthetic',ownerId:owner,registrationId:id,registrationSha256:packageSha,localOrigin,...options});
const run=(sweep:object,options:object={})=>new LocalConditionalCollectionV2RefreshRuntime(database.db).run(request({sweep,...options}));
async function initial(){const r=await new LocalConditionalCollectionV2Runtime(database.db).run(request());expect(r.status).toBe('complete');return r.journalHeadSha256;}
async function start(){return {action:'begin',sweepId:randomUUID(),expectedHeadSha256:await initial()};}
async function count(){return (await sql`SELECT count(*)::int AS n FROM conditional_collection_v2_sweeps`.execute(database.db)).rows[0]!.n;}
async function cli(payload:object,connection=database.url){const path=join(fixtureDir,randomUUID()+'.json');await writeFile(path,JSON.stringify(payload));
 return new Promise<{code:number|null;stdout:string;stderr:string}>((done,reject)=>{const child=spawn(process.execPath,['tools/research/run-conditional-collection-v2-refresh.mjs','--request',path],
 {cwd:process.cwd(),windowsHide:true,env:{...process.env,DATABASE_URL:connection}});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 child.on('error',reject);child.on('close',code=>done({code,stdout,stderr}));});}
it('refresh finds a new BIGINT map, keeps old details, resumes after limit and begin retry is idempotent',async()=>{
 const s=await start();handler=(path,res)=>res.end(JSON.stringify(path==='/leagues/90001/matches'?[map(),map('9007199254741202')]:path==='/matches/9007199254741202'?map('9007199254741202'):[]));
 expect((await run(s,{maxRequests:1})).reason).toBe('run_request_limit');expect(await count()).toBe(1);
 const result=await run({action:'resume',sweepId:s.sweepId});expect(result).toMatchObject({status:'complete',sweepComplete:true,attemptsObservedTotal:8,observedPossibleMaps:2,denominatorComplete:false});
 expect(paths.slice(4)).toEqual(['/leagues/90001/matches','/leagues/90002/matches','/matches/9007199254741202','/proMatches']);
 expect((await run(s)).status).toBe('complete');expect(paths).toHaveLength(8);expect(await count()).toBe(1);
 const next={action:'begin',sweepId:randomUUID(),expectedHeadSha256:result.journalHeadSha256};expect((await run(next)).status).toBe('complete');
 expect(paths.slice(8)).toEqual(['/leagues/90001/matches','/leagues/90002/matches','/proMatches']);expect(await count()).toBe(2);
 expect((await run(s)).status).toBe('blocked');expect(paths).toHaveLength(11);
},120000);
it('incomplete initial traversal, stale head, missing sweep and conflicting id cannot create a boundary',async()=>{
 const partial=await new LocalConditionalCollectionV2Runtime(database.db).run(request({maxRequests:1}));
 expect((await run({action:'begin',sweepId:randomUUID(),expectedHeadSha256:partial.journalHeadSha256})).status).toBe('blocked');expect(await count()).toBe(0);
 const head=await initial(),s={action:'begin',sweepId:randomUUID(),expectedHeadSha256:head};
 expect((await run({...s,expectedHeadSha256:'0'.repeat(64)})).status).toBe('blocked');
 expect((await run({action:'resume',sweepId:s.sweepId})).status).toBe('blocked');expect(await count()).toBe(0);
 await run(s,{maxRequests:1});expect((await run({...s,expectedHeadSha256:'0'.repeat(64)})).status).toBe('blocked');
 expect((await run({action:'begin',sweepId:randomUUID(),expectedHeadSha256:(await journal.read(owner,id)).headSha256})).status).toBe('blocked');expect(await count()).toBe(1);
},120000);
it('concurrent starts serialize on shared runtime lock and one boundary survives',async()=>{
 const s=await start();const results=await Promise.all([run(s,{maxRequests:1}),run({...s,sweepId:randomUUID()},{maxRequests:1})]);
 expect(results.some(r=>r.status==='busy'||r.status==='blocked')).toBe(true);expect(await count()).toBe(1);expect(paths).toHaveLength(5);
},90000);
it('marker is durable before HTTP and immutable; storage rejection consumes no attempts',async()=>{
 const s=await start();await sql`ALTER TABLE conditional_collection_v2_sweeps ADD CONSTRAINT synthetic_sweep_failure CHECK(false)`.execute(database.db);
 try{expect((await run(s)).status).toBe('blocked');expect(await count()).toBe(0);expect(paths).toHaveLength(4);}
 finally{await sql`ALTER TABLE conditional_collection_v2_sweeps DROP CONSTRAINT synthetic_sweep_failure`.execute(database.db);}
 const discovery=new ConditionalCollectionV2RefreshDiscovery(database.db,s);await discovery.read(owner,id);expect(await count()).toBe(1);expect(paths).toHaveLength(4);
 for(const query of [sql`UPDATE conditional_collection_v2_sweeps SET base_request_count=1`,sql`DELETE FROM conditional_collection_v2_sweeps`,sql`TRUNCATE conditional_collection_v2_sweeps`])await expect(query.execute(database.db)).rejects.toThrow('immutable');
 expect((await run({action:'resume',sweepId:s.sweepId})).status).toBe('complete');expect(paths).toHaveLength(7);
},90000);
it('refresh retains global pagination across restart, without treating a short page as an end',async()=>{
 const s=await start();handler=(path,res)=>res.end(JSON.stringify(path==='/proMatches'?[map('9007199254741202')]:path==='/matches/9007199254741202'?map('9007199254741202'):[]));
 expect((await run(s,{maxRequests:3})).reason).toBe('run_request_limit');const result=await run({action:'resume',sweepId:s.sweepId});expect(result.status).toBe('complete');
 expect(paths.slice(4)).toEqual(['/leagues/90001/matches','/leagues/90002/matches','/proMatches','/matches/9007199254741202','/proMatches?less_than_match_id=9007199254741202']);
},90000);
it('429 and invalid JSON remain stopping evidence after refresh restart',async()=>{
 const s=await start();handler=(_path,res)=>{res.writeHead(429,{'retry-after':'60'});res.end();};
 expect((await run(s)).reason).toBe('transport_attempt_failed');expect((await run(s)).reason).toBe('retry_after');expect(paths).toHaveLength(5);
 await clock('2026-12-04T00:02:00.000Z');await sql`DELETE FROM provider_quotas`.execute(database.db);handler=(_path,res)=>res.end('{');
 expect((await run(s)).reason).toBe('transport_attempt_failed');expect((await run(s)).reason).toBe('invalid_source_response');expect(paths).toHaveLength(6);
},90000);
it('stored completion resumes after crash without resending, then completes refresh',async()=>{
 const s=await start();await sql`ALTER TABLE conditional_collection_v2_events ADD CONSTRAINT synthetic_refresh_completion CHECK(sequence<>9)`.execute(database.db);
 try{expect((await run(s)).status).toBe('blocked');expect(paths).toHaveLength(5);}finally{await sql`ALTER TABLE conditional_collection_v2_events DROP CONSTRAINT synthetic_refresh_completion`.execute(database.db);}
 const result=await run({action:'resume',sweepId:s.sweepId});expect(result.responsesResumedThisRun).toBe(1);expect(result.status).toBe('complete');expect(paths).toHaveLength(7);
},90000);
it('window, cancellation, inactive owner and manifest drift reject new refresh before HTTP',async()=>{
 const s=await start();await clock('2026-12-25T00:00:00.000Z');expect((await run(s)).status).toBe('blocked');expect(await count()).toBe(0);
 await clock('2026-12-04T00:00:00.000Z');const c=new AbortController();c.abort();expect((await new LocalConditionalCollectionV2RefreshRuntime(database.db).run(request({sweep:s}),{signal:c.signal})).reason).toBe('cancelled');
 await sql`UPDATE app_users SET is_active=false WHERE id=${owner}::uuid`.execute(database.db);expect((await run(s)).status).toBe('blocked');
 await sql`UPDATE app_users SET is_active=true WHERE id=${owner}::uuid`.execute(database.db);
 const registration=await journal.registration(owner,id),p=JSON.parse(registration.packageText);delete p.executable.code['tools/research/conditional-collection-v2-refresh.mjs'];
 await expect(verifyCollectionV2RefreshManifest({...registration,packageText:JSON.stringify(p)})).rejects.toThrow('registered_v2_refresh_code_changed');
 expect(paths).toHaveLength(4);expect(await count()).toBe(0);
},90000);
it('CLI resumes persisted refresh and rejects working database, secrets and remote origin before connection',async()=>{
 const s=await start();const result=await cli(request({sweep:s,maxRequests:1}));expect(result.code).toBe(0);expect(JSON.parse(result.stdout).reason).toBe('run_request_limit');
 for(const [payload,url] of [[request({sweep:s}),'postgresql://secret:do-not-print@127.0.0.1/production'],
 [request({sweep:s,localOrigin:'https://api.opendota.com?api_key=do-not-print'}),database.url],[request({sweep:s,token:'do-not-print'}),database.url]] as const){
 const bad=await cli(payload,url);expect(bad.code).toBe(1);expect(bad.stdout+bad.stderr).not.toContain('do-not-print');}
 expect(paths).toHaveLength(5);
},90000);
it('raw SQL cannot forge a boundary and replay detects marker corruption',async()=>{
 const s=await start();
 await expect(sql`INSERT INTO conditional_collection_v2_sweeps(registration_id,sweep_id,sequence,base_head_sha256,base_request_count)
 VALUES(${id}::uuid,${s.sweepId}::uuid,0,${s.expectedHeadSha256},3)`.execute(database.db)).rejects.toThrow('boundary_conflict');
 await new ConditionalCollectionV2RefreshDiscovery(database.db,s).read(owner,id);
 await database.db.transaction().execute(async tx=>{
  await sql`ALTER TABLE conditional_collection_v2_sweeps DISABLE TRIGGER USER`.execute(tx);
  await sql`UPDATE conditional_collection_v2_sweeps SET marker_sha256=${'0'.repeat(64)}`.execute(tx);
  await sql`ALTER TABLE conditional_collection_v2_sweeps ENABLE TRIGGER USER`.execute(tx);
 });
 expect((await run(s)).status).toBe('blocked');expect(paths).toHaveLength(4);expect((await journal.read(owner,id)).attempts.total).toBe(4);
},90000);
it('unknown in-flight refresh result cannot be resent or replaced with another sweep',async()=>{
 const s=await start();await new ConditionalCollectionV2RefreshDiscovery(database.db,s).read(owner,id);
 await journal.append(owner,id,s.expectedHeadSha256,randomUUID(),{kind:'reserve',requestId:randomUUID(),endpoint:'/leagues/90001/matches'});
 for(const sweep of [s,{action:'resume',sweepId:s.sweepId},{action:'begin',sweepId:randomUUID(),expectedHeadSha256:(await journal.read(owner,id)).headSha256}])
 expect((await run(sweep)).reason).toBe('inflight_outcome_unknown');
 expect(paths).toHaveLength(4);expect(await count()).toBe(1);expect((await journal.read(owner,id)).attempts.total).toBe(5);
},90000);
it('refresh snapshot time includes the later persisted boundary, retaining source snapshot provenance',async()=>{
 const s=await start(),discovery=new ConditionalCollectionV2RefreshDiscovery(database.db,s);
 const transaction=discovery.journal.transaction.bind(discovery.journal);let n=0;
 discovery.journal.transaction=async(...args:unknown[])=>{if(++n===3)await clock('2026-12-04T00:00:01.000Z');return transaction(...args);};
 const {report}=await discovery.read(owner,id);
 expect(report.sourceDiscoverySnapshotAt).toBe('2026-12-04T00:00:00.000Z');
 expect(report.snapshotAt).toBe('2026-12-04T00:00:01.000Z');expect(report.sweepStartedAt).toBe(report.snapshotAt);
 expect(paths).toHaveLength(4);
},90000);
