import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {prepareV1Data} from '../../packages/db/dist/v1-data.js';
import {playerHistoryQuery} from '../../packages/ingestion/dist/player-history.js';
import {captureRetestBatch,readRetestState,retestStatus,appendRetestFile,closeRetestCollection,recoverRetestLock} from '../../scripts/lib/v1-retest-store.mjs';
import {hash,sha,terminalKey} from '../../scripts/lib/v1-retest-collection.mjs';
import {retestDeadlineFetch} from '../../scripts/lib/v1-retest-provider.mjs';
const encode=o=>JSON.stringify(o)+'\n',stamp=v=>({...v,fingerprint:hash(v)});
const slots=[0,1,2,3,4,128,129,130,131,132];
async function fixture(n=1){
 const root=await mkdtemp(join(tmpdir(),'v1-retest-collection-'));for(const d of ['admissions','outcomes','cached','runs','recoveries'])await mkdir(join(root,d));
 let time=Date.parse('2026-11-06T12:00:00.000Z');const now=()=>new Date(time).toISOString();
 const source={request:{schemaVersion:1,profile:'pre-match-player-elo-data-v1',purpose:'development_only',fromAt:'2024-01-01T00:00:00.000Z',toAt:'2026-11-01T00:00:00.000Z',snapshotAt:now(),maxMaps:5000},identityRevision:'1',candidates:[],aliases:[],identities:[],code:[{path:'synthetic-test.js',sha256:'a'.repeat(64)}],syntheticOnly:true};
 const ctx={root,now,configSha:'b'.repeat(64),config:{syntheticOnly:false,maxRequestsPerRun:50,maxHistoryHttpAttempts:3,historyPolicy:{windowDays:730,maxMapsPerAccount:10}},
  store:{createdAt:now()},plan:{fingerprint:'c'.repeat(64),request:{maxInventoryMaps:5000,warmupFromAt:'2024-01-01T00:00:00.000Z',events:[{fromAt:'2026-02-01T00:00:00.000Z'}]},collection:{maxDetailAttemptsPerMap:3,collectionDeadline:'2026-11-13T00:00:00.000Z'}},
  review:{ledger:[]},catalogue:[{leagueid:'100',tier:'professional'}],exposure:{blockedMatchIds:[],opendotaSeriesIds:[]},canonical:prepareV1Data(source),cache:{matches:[]}};
 const map=id=>({match_id:id,series_id:id,start_time:Date.parse('2026-02-10T00:00:00.000Z')/1000,duration:3600,radiant_win:true,leagueid:'100',radiant_team_id:'1',dire_team_id:'2',lobby_type:1,players:slots.map((player_slot,i)=>({player_slot,account_id:String(100+i)}))});
 const obs=(raw,endpoint)=>({source:{provider:'opendota',adapterVersion:'synthetic-retest-test-v1',endpoint:endpoint??`/matches/${raw.match_id}`,fetchedAt:now(),knownAt:null,payloadSha256:sha(JSON.stringify(raw))},rawBody:JSON.stringify(raw)});
 for(let i=0;i<n;i++){const m=map(String(100000001+i));ctx.review.ledger.push({matchId:m.match_id,leagueId:m.leagueid,providerSeriesId:m.series_id,startTime:m.start_time,radiantTeamId:m.radiant_team_id,direTeamId:m.dire_team_id,inTargetWindow:true,exposureExcluded:false,reasons:[]});}
 let http=0,created=0;
 const provider=handler=>async(limit,hooks)=>{created++;const call=async(key,endpoint,args)=>{hooks.guard();await hooks.beforeRequest();http++;if(handler)return handler({key,endpoint,args,hooks});await hooks.observe(200,null);return key.startsWith('map-')?obs(map(key.slice(4))):obs({err:null,rows:[]},endpoint);};
  return {client:{getMatchSource:id=>call('map-'+id,`/matches/${id}`)},discover:(...args)=>call('history','/explorer?'+new URLSearchParams({sql:playerHistoryQuery(...args)}),args),close:async()=>{}};};
 return {ctx,map,obs,now,advance:ms=>time+=ms,setTime:at=>time=Date.parse(at),provider,http:()=>http,created:()=>created,
  dispose:async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert(basename(root).startsWith('v1-retest-collection-'));await rm(root,{recursive:true,force:true});}};
}
const admission=(f,key='map-100000001',ordinal=1)=>stamp({schemaVersion:2,configSha256:f.ctx.configSha,key,ordinal,runId:randomUUID(),admittedAt:f.now(),endpoint:`/matches/${key.slice(4)}`});
test('cached and successful map receipts are reused; empty history finishes once with zero future HTTP',async()=>{
 const f=await fixture(2);try{
  const path=join(f.ctx.root,'source.json'),input=f.obs(f.map('100000001'));await writeFile(path,encode(input));f.ctx.cache.matches.push({matchId:'100000001',path,sha256:sha(encode(input))});
  let r=await captureRetestBatch(f.ctx,'targets',f.provider());assert.equal(r.providerRequests,1);assert.equal(r.cached,1);
  r=await captureRetestBatch(f.ctx,'targets',f.provider());assert.equal(r.providerRequests,0);assert.equal(f.http(),1);
  r=await captureRetestBatch(f.ctx,'history',f.provider());assert.equal(r.status,'collection_closed');assert.equal(r.providerRequests,2);
  const closed=await readFile(join(f.ctx.root,'closure.json')),count=f.created();
  for(const phase of ['targets','history'])assert.equal((await captureRetestBatch(f.ctx,phase,f.provider())).providerRequests,0);
  assert.equal(f.created(),count);assert.deepEqual(await readFile(join(f.ctx.root,'closure.json')),closed);
  const report=await retestStatus(f.ctx);assert.equal(report.summary.unexposedMaps,2);assert.equal(report.metrics,null);assert.equal(report.evaluationPerformed,false);
 }finally{await f.dispose();}
});
test('three actual failed HTTP attempts across batches exhaust a map and retain it in coverage',async()=>{
 const f=await fixture();try{
  const provider=f.provider(async({hooks})=>{await hooks.observe(503,null);throw {code:'source_http_error',status:503};});
  for(let i=0;i<3;i++){const r=await captureRetestBatch(f.ctx,'targets',provider);assert.equal(r.providerRequests,1);f.advance(2000);}
  const state=await readRetestState(f.ctx);assert.equal(state.admissions.length,3);assert.equal(state.records.size,0);assert(state.closure);
  assert.equal(state.closure.report.summary.unexposedMaps,1);assert.equal(state.closure.report.unavailableSources[0].attempts,3);
  assert.equal((await captureRetestBatch(f.ctx,'targets',provider)).providerRequests,0);assert.equal(f.http(),3);
 }finally{await f.dispose();}
});
test('a crash after admission consumes its attempt; recovery does not refund an uncertain request',async()=>{
 const f=await fixture();try{
  await appendRetestFile(join(f.ctx.root,'admissions','map-100000001.1.json'),admission(f));
  await captureRetestBatch(f.ctx,'targets',f.provider());
  const state=await readRetestState(f.ctx);assert.equal(state.admissions.length,2);assert.equal(state.outcomes[0].status,'interrupted');assert.equal(state.records.size,1);
  assert.equal(state.outcomes[1].ordinal,2);assert.equal(f.http(),1);
 }finally{await f.dispose();}
});
test('50-attempt run limit is independent of per-map limit, and resumes only the missing map',async()=>{
 const f=await fixture(51);try{
  const first=await captureRetestBatch(f.ctx,'targets',f.provider());assert.equal(first.providerRequests,50);assert.equal(first.stopped,'batch_limit');
  const second=await captureRetestBatch(f.ctx,'targets',f.provider());assert.equal(second.providerRequests,1);assert.equal(f.http(),51);
  assert.equal((await readRetestState(f.ctx)).admissions.length,51);
 }finally{await f.dispose();}
});
test('quota refusal before admission uses zero map attempts and persists cooldown across restarts',async()=>{
 const f=await fixture();try{
  let constructed=0;const provider=async()=>{constructed++;return {client:{getMatchSource:async()=>{throw {code:'request_budget_exhausted',retryAfterMs:3600000};}},close:async()=>{}};};
  const r=await captureRetestBatch(f.ctx,'targets',provider);assert.equal(r.providerRequests,0);assert.equal((await readRetestState(f.ctx)).admissions.length,0);
  assert.equal((await captureRetestBatch(f.ctx,'targets',provider)).status,'cooldown');assert.equal(constructed,1);
  f.advance(3600001);await captureRetestBatch(f.ctx,'targets',f.provider());assert.equal(f.http(),1);
 }finally{await f.dispose();}
});
test('Retry-After from a real 429 attempt survives the next batch and does not exceed the cap',async()=>{
 const f=await fixture();try{
  const r=await captureRetestBatch(f.ctx,'targets',f.provider(async({hooks})=>{await hooks.observe(429,10000);throw {code:'source_rate_limited',status:429,retryAfterMs:10000};}));
  assert.equal(r.providerRequests,1);const count=f.created();assert.equal((await captureRetestBatch(f.ctx,'targets',f.provider())).status,'cooldown');assert.equal(f.created(),count);
  f.advance(10001);await captureRetestBatch(f.ctx,'targets',f.provider());assert.equal((await readRetestState(f.ctx)).admissions.length,2);
 }finally{await f.dispose();}
});
test('internal history retries each get a durable admission and stop at three across resumes',async()=>{
 const f=await fixture();try{
  await captureRetestBatch(f.ctx,'targets',f.provider());
  const provider=async(limit,hooks)=>({discover:async()=>{for(let i=0;i<2;i++){hooks.guard();await hooks.beforeRequest();await hooks.observe(500,null);f.advance(1001);}throw {code:'source_http_error',status:500};},close:async()=>{}});
  await captureRetestBatch(f.ctx,'history',provider);f.advance(2000);
  await captureRetestBatch(f.ctx,'history',provider);f.advance(2000);
  const state=await readRetestState(f.ctx);for(const group of Map.groupBy(state.admissions.filter(a=>a.key.startsWith('history-')),a=>a.key).values())assert.equal(group.length,3);
  assert(state.closure);assert.equal(state.records.size,1);assert.equal(state.closure.report.summary.missingHistoryJobs,2);
 }finally{await f.dispose();}
});
test('at the exact deadline closure keeps uncaptured targets and makes no provider calls',async()=>{
 const f=await fixture();try{
  f.setTime(f.ctx.plan.collection.collectionDeadline);const r=await captureRetestBatch(f.ctx,'targets',f.provider());
  assert.equal(r.status,'collection_closed');assert.equal(f.created(),0);const report=await retestStatus(f.ctx);
  assert.equal(report.summary.unexposedMaps,1);assert.equal(report.unavailableSources[0].attempts,0);assert(report.rows[0].reasons.includes('COLLECTION_DEADLINE'));
 }finally{await f.dispose();}
});
test('response after deadline is logged as late and never admitted into source history',async()=>{
 const f=await fixture();try{
  await captureRetestBatch(f.ctx,'targets',f.provider(async({hooks})=>{await hooks.observe(200,null);f.setTime(f.ctx.plan.collection.collectionDeadline);return f.obs(f.map('100000001'));}));
  const state=await readRetestState(f.ctx);assert.equal(state.records.size,0);assert.equal(state.outcomes[0].status,'late_response');assert.equal(state.closure.report.collection.lateResponses,1);
 }finally{await f.dispose();}
});
test('deadline crossing while waiting for quota blocks admission before fetch',async()=>{
 const f=await fixture();try{
  let fetches=0;const provider=async(limit,hooks)=>({client:{getMatchSource:async()=>{hooks.guard();f.setTime(f.ctx.plan.collection.collectionDeadline);await hooks.beforeRequest();fetches++;}},close:async()=>{}});
  const r=await captureRetestBatch(f.ctx,'targets',provider);assert.equal(r.status,'collection_closed');assert.equal(fetches,0);assert.equal((await readRetestState(f.ctx)).admissions.length,0);
 }finally{await f.dispose();}
});
test('404 is terminal after one request; early manual closure and synthetic live collection are refused',async()=>{
 const f=await fixture();try{
  await assert.rejects(closeRetestCollection(f.ctx,await readRetestState(f.ctx)),/work_not_terminal/);
  f.ctx.config.syntheticOnly=true;await assert.rejects(captureRetestBatch(f.ctx,'targets',f.provider()),/synthetic_live/);f.ctx.config.syntheticOnly=false;
  const r=await captureRetestBatch(f.ctx,'targets',f.provider(async({hooks})=>{await hooks.observe(404,null);throw {code:'source_http_error',status:404};}));
  assert.equal(r.status,'collection_closed');assert.equal(f.http(),1);assert(terminalKey(f.ctx,await readRetestState(f.ctx),'map-100000001',f.now()));
 }finally{await f.dispose();}
});
test('outcome/file tampering and out-of-scope admissions are rejected',async()=>{
 const f=await fixture();try{
  await captureRetestBatch(f.ctx,'targets',f.provider());const p=join(f.ctx.root,'outcomes','map-100000001.1.json');
  const original=await readFile(p),v=JSON.parse(original);v.record.observation.rawBody+=' ';await writeFile(p,encode(v));await assert.rejects(readRetestState(f.ctx),/artifact_hash/);
  await writeFile(p,original);await appendRetestFile(join(f.ctx.root,'admissions','map-999999999.1.json'),admission(f,'map-999999999'));
  await assert.rejects(readRetestState(f.ctx),/key_scope/);
 }finally{await f.dispose();}
});
test('complete pending admissions recover conservatively; partial pending bytes never become a captured record',async()=>{
 const f=await fixture();try{
  const a=admission(f),dir=join(f.ctx.root,'admissions');await writeFile(join(dir,'map-100000001.1.json.'+randomUUID()+'.pending'),encode(a));
  await writeFile(join(f.ctx.root,'outcomes','map-100000001.1.json.'+randomUUID()+'.pending'),'{"interrupted":');
  await captureRetestBatch(f.ctx,'targets',f.provider());const state=await readRetestState(f.ctx);
  assert.equal(state.admissions.length,2);assert.equal(state.outcomes[0].status,'interrupted');assert.equal(state.records.size,1);
  assert.equal((await readdir(join(f.ctx.root,'outcomes'))).filter(n=>n.endsWith('.pending')).length,1);
 }finally{await f.dispose();}
});
test('exclusive publication never replaces a different artifact',async()=>{
 const f=await fixture();try{
  const a=admission(f),path=join(f.ctx.root,'admissions','map-100000001.1.json');await appendRetestFile(path,a);
  await assert.rejects(appendRetestFile(path,stamp({...a,endpoint:'/matches/2',fingerprint:undefined})),e=>e.code==='EEXIST');assert.deepEqual(JSON.parse(await readFile(path)),a);
  // Conflicting pending evidence remains visible and blocks silent recovery.
  await assert.rejects(readRetestState(f.ctx),/artifact_hash|pending_conflict/);
 }finally{await f.dispose();}
});
test('deadline crossing at any cache publication boundary never leaves an invalid admitted record',async()=>{
 for(let boundary=1;boundary<=18;boundary++){
  const f=await fixture();try{
   const path=join(f.ctx.root,'source.json'),input=f.obs(f.map('100000001'));await writeFile(path,encode(input));f.ctx.cache.matches.push({matchId:'100000001',path,sha256:sha(encode(input))});
   let calls=0;f.ctx.now=()=>++calls>=boundary?f.ctx.plan.collection.collectionDeadline:f.now();
   await captureRetestBatch(f.ctx,'targets',f.provider());await readRetestState(f.ctx);assert.equal(f.http(),0);
  }finally{await f.dispose();}
 }
});
test('closed state rejects new journal entries even if their hashes are internally valid',async()=>{
 const f=await fixture();try{
  await captureRetestBatch(f.ctx,'targets',f.provider());await captureRetestBatch(f.ctx,'history',f.provider());
  const value=stamp({schemaVersion:2,format:'retest-collection-run-v2',configSha256:f.ctx.configSha,runId:randomUUID(),at:f.now(),resumeNotBeforeAt:null});
  await appendRetestFile(join(f.ctx.root,'runs',value.runId+'.json'),value);await assert.rejects(readRetestState(f.ctx),/closure_binding/);
 }finally{await f.dispose();}
});
test('deadline checks stay valid at every live admission and publication boundary',async()=>{
 for(let boundary=1;boundary<=24;boundary++){
  const f=await fixture();try{
   let calls=0;f.ctx.now=()=>++calls>=boundary?f.ctx.plan.collection.collectionDeadline:f.now();
   await captureRetestBatch(f.ctx,'targets',f.provider());await readRetestState(f.ctx);
  }finally{await f.dispose();}
 }
});
test('final network boundary refuses a request if the deadline passed after durable admission',async()=>{
 let at='2026-11-12T23:59:59.999Z',calls=0;
 const fetcher=retestDeadlineFetch('2026-11-13T00:00:00.000Z',async()=>{calls++;return new Response('{}');},()=>at);
 await fetcher('https://example.invalid');at='2026-11-13T00:00:00.000Z';assert.throws(()=>fetcher('https://example.invalid'),/deadline/);assert.equal(calls,1);
});
test('lock recovery checks the exact store and never removes a living process lock',async()=>{
 const f=await fixture();try{
  const store={format:'retest-source-collection-v2',configSha256:f.ctx.configSha},bytes=encode(store),digest=sha(bytes);await writeFile(join(f.ctx.root,'collection.json'),bytes);
  await writeFile(join(f.ctx.root,'lock'),JSON.stringify({pid:process.pid,storeSha256:digest}));await assert.rejects(recoverRetestLock(f.ctx.root,digest),/process_alive/);
  const child=spawn(process.execPath,['-e',''],{stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  await writeFile(join(f.ctx.root,'lock'),JSON.stringify({pid:child.pid,storeSha256:digest}));assert.equal((await recoverRetestLock(f.ctx.root,digest)).status,'dead_process_lock_removed');
 }finally{await f.dispose();}
});
