import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {spawn} from 'node:child_process';
import {prepareV1Data} from '../../packages/db/dist/v1-data.js';
import {sha} from '../../scripts/lib/v1-historical-protocol.mjs';
import {assessHistoricalMap,historicalHistoryJobs,decodeHistoricalHistory,reviewHistoricalCollection,hash} from '../../scripts/lib/v1-historical-collection.mjs';
import {captureHistoricalBatch,readHistoricalRecords,validateHistoricalInventory,recoverHistoricalLock} from '../../scripts/lib/v1-historical-store.mjs';
const now='2026-11-06T12:00:00.000Z',slots=[0,1,2,3,4,128,129,130,131,132];
function fixture(){
 const source={request:{schemaVersion:1,profile:'pre-match-player-elo-data-v1',purpose:'development_only',fromAt:'2024-01-01T00:00:00.000Z',toAt:'2026-11-01T00:00:00.000Z',snapshotAt:now,maxMaps:5000},
  identityRevision:'1',candidates:[],aliases:[],identities:[],code:[{path:'synthetic-test.js',sha256:'a'.repeat(64)}],syntheticOnly:true};
 const ctx={configSha:'b'.repeat(64),config:{syntheticOnly:true,maxRequestsPerRun:2,historyPolicy:{windowDays:730,maxMapsPerAccount:10}},
  plan:{fingerprint:'c'.repeat(64),request:{maxInventoryMaps:5000,warmupFromAt:'2024-01-01T00:00:00.000Z',events:[{fromAt:'2026-08-01T00:00:00.000Z'}]}},
  review:{ledger:[]},catalogue:[{leagueid:'100',tier:'professional'}],exposure:{blockedMatchIds:[],opendotaSeriesIds:[]},canonical:prepareV1Data(source),cache:{matches:[]}};
 const map=(id,series='10',start=Date.parse('2026-08-10T00:00:00Z')/1000)=>({match_id:id,series_id:series,start_time:start,duration:3600,radiant_win:true,leagueid:'100',radiant_team_id:'1',dire_team_id:'2',lobby_type:1,players:slots.map((player_slot,i)=>({player_slot,account_id:String(100+i)}))});
 const obs=(raw,endpoint=`/matches/${raw.match_id}`)=>({source:{provider:'opendota',adapterVersion:'synthetic-test-v1',endpoint,fetchedAt:now,knownAt:null,payloadSha256:sha(JSON.stringify(raw))},rawBody:JSON.stringify(raw)});
 const add=(m,extras={})=>ctx.review.ledger.push({matchId:m.match_id,leagueId:m.leagueid,providerSeriesId:m.series_id,startTime:m.start_time,radiantTeamId:m.radiant_team_id,direTeamId:m.dire_team_id,inTargetWindow:true,exposureExcluded:false,reasons:[],...extras});
 return {ctx,map,obs,add};
}
test('native slots and ten distinct accounts are required; hero/role/patch fields are unused',()=>{
 const f=fixture(),m=f.map('100000001');f.add(m);m.players.reverse();m.patch='bad-unused';m.players[0].hero_id='unused';
 assert.equal(assessHistoricalMap(f.ctx,m.match_id,f.obs(m),now).sourceEligible,true);
 m.players[0].account_id=m.players[1].account_id;assert(assessHistoricalMap(f.ctx,m.match_id,f.obs(m),now).reasons.includes('ACTUAL_ACCOUNTS_INVALID'));
 m.players[0].account_id='4294967295';assert.equal(assessHistoricalMap(f.ctx,m.match_id,f.obs(m),now).sourceEligible,false);
});
test('pro classification, completion, two teams and discovery binding are independent gates',()=>{
 for(const mutate of [m=>m.duration=0,m=>m.radiant_win=null,m=>m.radiant_team_id='2',m=>m.series_id='11',m=>m.leagueid='999',m=>m.lobby_type=7]){
  const f=fixture(),m=f.map('100000001');f.add(m);mutate(m);assert.equal(assessHistoricalMap(f.ctx,m.match_id,f.obs(m),now).sourceEligible,false);
 }
});
test('hash, endpoint, future source clock and synthetic payload are rejected',()=>{
 const f=fixture(),m=f.map('100000001');
 for(const mutate of [o=>o.rawBody+=' ',o=>o.source.endpoint='/matches/2',o=>o.source.fetchedAt='2099-01-01T00:00:00.000Z']){const o=f.obs(m);mutate(o);assert.throws(()=>assessHistoricalMap(f.ctx,m.match_id,o,now));}
 assert.throws(()=>assessHistoricalMap(f.ctx,m.match_id,f.obs({...m,synthetic:true}),now),/synthetic_source/);
});
test('history discovery waits for complete target capture and groups each account once',()=>{
 const f=fixture(),m=f.map('100000001');f.add(m);assert.equal(historicalHistoryJobs(f.ctx,[]),null);
 const jobs=historicalHistoryJobs(f.ctx,[assessHistoricalMap(f.ctx,m.match_id,f.obs(m),now)]);
 assert.equal(jobs.length,2);assert.equal(new Set(jobs.flatMap(j=>j.accounts)).size,10);assert.equal(jobs[0].cutoffAt,'2026-08-01T00:00:00.000Z');
 const r={account_id:'100',match_id:'100000020',leagueid:'100',start_time:Date.parse(jobs[0].cutoffAt)/1000-100,duration:100,radiant_win:true,player_slot:0,tier:'professional'};
 assert.throws(()=>decodeHistoricalHistory(jobs[0],f.obs({rows:[r],err:null},jobs[0].endpoint),now));
 r.duration=99;assert.equal(decodeHistoricalHistory(jobs[0],f.obs({rows:[r],err:null},jobs[0].endpoint),now).rows.length,1);
});
test('recovered series propagates prior exposure to siblings and incomplete members remain visible',()=>{
 const f=fixture(),a=f.map('100000001'),b=f.map('100000002');f.add(a,{providerSeriesId:null,exposureExcluded:true});f.add(b);
 const records=new Map([['map-'+a.match_id,{observation:f.obs(a)}],['map-'+b.match_id,{observation:f.obs(b)}]]);
 const r=reviewHistoricalCollection(f.ctx,records,now);assert.equal(r.summary.priorExposedMaps,2);assert.equal(r.metrics,null);assert.equal(r.deployable,false);
 records.delete('map-'+b.match_id);assert.equal(reviewHistoricalCollection(f.ctx,records,now).summary.capturedTargetMaps,1);
});
test('history completion is strictly earlier, map IDs are deduplicated and zero history is explicit',()=>{
 const f=fixture(),target=f.map('100000001');f.add(target);
 const previous=f.map('100000002','20',target.start_time-3600);f.add(previous,{exposureExcluded:true});
 let records=new Map([['map-'+target.match_id,{observation:f.obs(target)}],['map-'+previous.match_id,{observation:f.obs(previous)}]]);
 let r=reviewHistoricalCollection(f.ctx,records,now);assert.deepEqual(r.rows[0].priorSourceMapsPerPlayer,Array(10).fill(0));
 previous.duration=3599;records.set('map-'+previous.match_id,{observation:f.obs(previous)});r=reviewHistoricalCollection(f.ctx,records,now);
 assert.deepEqual(r.rows[0].priorSourceMapsPerPlayer,Array(10).fill(1));assert.equal(r.canonicalOutcomeEligibilityVerified,false);
 assert(!JSON.stringify(r).includes('radiant_win'));assert.equal(r.summary.currentIdentityReadyMaps,0);
});
test('metadata series conflicts remain ineligible even when each detail is structurally valid',()=>{
 const f=fixture(),m=f.map('100000001');f.add(m,{reasons:['SERIES_CONTEXT_CONFLICT']});
 const r=reviewHistoricalCollection(f.ctx,new Map([['map-'+m.match_id,{observation:f.obs(m)}]]),now);
 assert(r.rows[0].reasons.includes('SERIES_CONTEXT_CONFLICT'));
});
async function temp(fn){const root=await mkdtemp(join(tmpdir(),'historical-collection-'));try{await mkdir(join(root,'records'));await mkdir(join(root,'attempts'));await fn(root);}finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert(basename(root).startsWith('historical-collection-'));await rm(root,{recursive:true,force:true});}}
test('successful cached responses are reused without creating a provider; retry is idempotent',()=>temp(async root=>{
 const f=fixture(),m=f.map('100000001');f.add(m);f.ctx.root=root;f.ctx.config.syntheticOnly=false;
 const path=join(root,'cache.json'),bytes=JSON.stringify(f.obs(m));await writeFile(path,bytes);f.ctx.cache.matches=[{matchId:m.match_id,path,sha256:sha(bytes)}];
 let calls=0;const create=async()=>{calls++;throw Error('must not request');};
 const a=await captureHistoricalBatch(f.ctx,'targets',create);assert.equal(a.cached,1);assert.equal(calls,0);
 const before=await readFile(join(root,'records','map-'+m.match_id+'.json'),'utf8');
 const b=await captureHistoricalBatch(f.ctx,'targets',create);assert.equal(b.cached,0);assert.equal(calls,0);assert.equal(await readFile(join(root,'records','map-'+m.match_id+'.json'),'utf8'),before);
}));
test('bounded batches persist each response and resume missing maps after source failure',()=>temp(async root=>{
 const f=fixture(),maps=[1,2,3].map(i=>f.map(String(100000000+i),String(i)));maps.forEach(m=>f.add(m));f.ctx.root=root;f.ctx.config.syntheticOnly=false;
 let calls=0;const provider=async()=>({client:{getMatchSource:async id=>{calls++;if(id===maps[1].match_id)throw {code:'source_rate_limited',retryAfterMs:10000};return f.obs(maps.find(m=>m.match_id===id));}},requests:()=>calls,close:async()=>{}});
 const first=await captureHistoricalBatch(f.ctx,'targets',provider);assert.equal(first.stopped,'source_rate_limited');assert.equal((await readHistoricalRecords(f.ctx)).size,1);
 const success=async()=>({client:{getMatchSource:async id=>{calls++;return f.obs(maps.find(m=>m.match_id===id));}},requests:()=>calls,close:async()=>{}});
 await captureHistoricalBatch(f.ctx,'targets',success);assert.equal((await readHistoricalRecords(f.ctx)).size,3);assert.equal(calls,4);
}));
test('corrupt receipt, foreign map and synthetic live mode fail before provider calls',()=>temp(async root=>{
 const f=fixture();f.ctx.root=root;let calls=0;const create=async()=>{calls++;throw Error();};
 await assert.rejects(captureHistoricalBatch(f.ctx,'targets',create),/synthetic_live/);assert.equal(calls,0);
 const m=f.map('100000001'),body={schemaVersion:1,configSha256:f.ctx.configSha,key:'map-'+m.match_id,storedAt:now,origin:'live',cacheRef:null,observation:f.obs(m)};
 await writeFile(join(root,'records',body.key+'.json'),JSON.stringify({...body,fingerprint:hash(body)}));
 assert.throws(()=>validateHistoricalInventory(f.ctx,new Map([[body.key,body]])),/map_scope/);
 body.observation.rawBody+=' ';await writeFile(join(root,'records',body.key+'.json'),JSON.stringify({...body,fingerprint:'a'.repeat(64)}));await assert.rejects(readHistoricalRecords(f.ctx),/record_binding/);
}));
test('a fully written interrupted receipt is recovered without another provider request',()=>temp(async root=>{
 const f=fixture(),m=f.map('100000001');f.add(m);f.ctx.root=root;f.ctx.config.syntheticOnly=false;
 const body={schemaVersion:1,configSha256:f.ctx.configSha,key:'map-'+m.match_id,storedAt:now,origin:'live',cacheRef:null,observation:f.obs(m)};
 await writeFile(join(root,'records','.'+body.key+'-12345678.pending'),JSON.stringify({...body,fingerprint:hash(body)}));
 let calls=0;await captureHistoricalBatch(f.ctx,'targets',async()=>{calls++;throw Error('unexpected_http');});
 assert.equal(calls,0);assert.equal((await readHistoricalRecords(f.ctx)).size,1);
}));
test('lock recovery refuses a running process and removes only a verified dead process lock',()=>temp(async root=>{
 const bytes=JSON.stringify({format:'historical-source-collection-v1'});await writeFile(join(root,'collection.json'),bytes);
 await writeFile(join(root,'lock'),JSON.stringify({pid:process.pid,at:now}));await assert.rejects(recoverHistoricalLock(root,sha(bytes)),/process_alive/);
 assert.equal(JSON.parse(await readFile(join(root,'lock'),'utf8')).pid,process.pid);
 const child=spawn(process.execPath,['-e',''],{stdio:'ignore'});await new Promise((yes,no)=>{child.on('exit',yes);child.on('error',no);});
 await writeFile(join(root,'lock'),JSON.stringify({pid:child.pid,at:now}));assert.equal((await recoverHistoricalLock(root,sha(bytes))).status,'dead_process_lock_removed');
 await assert.rejects(readFile(join(root,'lock')),e=>e.code==='ENOENT');
}));
test('repeated map HTTP 500 does not block other maps or remove the failed series from coverage',()=>temp(async root=>{
 const f=fixture(),maps=[f.map('100000001'),f.map('100000002'),f.map('100000003','20')];maps.forEach(m=>f.add(m));f.ctx.root=root;f.ctx.config.syntheticOnly=false;f.ctx.config.maxRequestsPerRun=5;
 let calls=0;const provider=async()=>({client:{getMatchSource:async id=>{calls++;if(id==='100000001')throw {code:'source_http_error',status:500};return f.obs(maps.find(m=>m.match_id===id));}},requests:()=>calls,close:async()=>{}});
 await captureHistoricalBatch(f.ctx,'targets',provider);await captureHistoricalBatch(f.ctx,'targets',provider);
 const result=await captureHistoricalBatch(f.ctx,'targets',provider);assert.equal(calls,4);assert.equal(result.summary.capturedTargetMaps,2);assert.equal(result.summary.deferredTargetMaps,1);assert.equal(result.summary.settledTargetMaps,3);
 const report=reviewHistoricalCollection(f.ctx,await readHistoricalRecords(f.ctx),now);assert.equal(report.summary.unexposedMaps,3);assert.equal(report.summary.unexposedKnownSeries,2);
 assert.equal(report.rows[1].ready,false);assert(report.rows[0].reasons.includes('SOURCE_UNAVAILABLE_AFTER_BOUNDED_ATTEMPTS'));assert.equal(result.summary.historyJobs,2);
}));
test('one failing map allows other responses in the same batch; a broad outage stops after three maps',()=>temp(async root=>{
 const f=fixture(),maps=[1,2,3,4].map(i=>f.map(String(100000000+i),String(i)));maps.forEach(m=>f.add(m));f.ctx.root=root;f.ctx.config.syntheticOnly=false;f.ctx.config.maxRequestsPerRun=10;
 let calls=0;const provider=async()=>({client:{getMatchSource:async id=>{calls++;if(id==='100000001')throw {code:'source_http_error',status:500};return f.obs(maps.find(m=>m.match_id===id));}},requests:()=>calls,close:async()=>{}});
 const result=await captureHistoricalBatch(f.ctx,'targets',provider);assert.equal(result.summary.capturedTargetMaps,3);assert.equal(calls,4);
}));
test('three consecutive map server failures stop before traversing the remaining inventory',()=>temp(async root=>{
 const f=fixture();[1,2,3,4].map(i=>f.map(String(100000000+i),String(i))).forEach(m=>f.add(m));f.ctx.root=root;f.ctx.config.syntheticOnly=false;f.ctx.config.maxRequestsPerRun=20;
 let calls=0;const result=await captureHistoricalBatch(f.ctx,'targets',async()=>({client:{getMatchSource:async()=>{calls++;throw {code:'source_http_error',status:500};}},requests:()=>calls,close:async()=>{}}));
 assert.equal(calls,3);assert.equal(result.stopped,'source_http_error');
}));
test('not-yet-fetched history is pending, distinct from invalid captured data',()=>{
 const f=fixture(),m=f.map('100000001');f.add(m);const records=new Map([['map-'+m.match_id,{observation:f.obs(m)}]]);
 const job=historicalHistoryJobs(f.ctx,[assessHistoricalMap(f.ctx,m.match_id,f.obs(m),now)])[0];
 const row={account_id:'100',match_id:'100000099',leagueid:'100',start_time:Date.parse('2026-07-01T00:00:00Z')/1000,duration:3000,radiant_win:true,player_slot:0,tier:'professional'};
 records.set(job.key,{observation:f.obs({rows:[row],err:null},job.endpoint)});
 const report=reviewHistoricalCollection(f.ctx,records,now);assert.equal(report.summary.invalidHistoryMaps,0);assert.equal(report.summary.pendingHistoryMaps,1);assert.equal(report.summary.capturedHistoryMaps,0);
});
