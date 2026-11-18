import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validatePlan,validateObservation,collectQueries,summarizeDiscovery,boundedBudget} from '../../tools/research/post-draft-history-discovery.mjs';
import {playerHistoryQuery,OpenDotaError} from '../../packages/ingestion/dist/index.js';
const sha=s=>createHash('sha256').update(s).digest('hex');
const fixture=()=>({queries:[['10001'],['10002']].map(accountIds=>({accountIds,cutoffAt:'2026-09-05T18:05:56.000Z',options:{windowDays:730,maxMaps:10},page:{limit:10,cursors:{}}})),budget:{maxAccountMapRows:20}});
const row=(account_id='10001',match_id='9007199254740993',player_slot=0)=>({account_id,match_id,player_slot,start_time:1788000000,duration:2000,radiant_win:true,leagueid:'1',tier:'professional'});
function observation(q,rows){const data={rows,err:null},rawBody=JSON.stringify(data);return {data,rawBody,source:{provider:'opendota',endpoint:'/explorer?'+new URLSearchParams({sql:playerHistoryQuery(q.accountIds,q.cutoffAt,q.options,q.page)}),payloadSha256:sha(rawBody),knownAt:null,fetchedAt:'2026-11-13T00:00:00.000Z'}};}

test('registered proposal scope rejects changed accounts, cutoff, retries and side-effect budgets',()=>{
 const p=JSON.parse(readFileSync(new URL('../../docs/evidence/s3-04-history-discovery-proposal.json',import.meta.url),'utf8'));
 const a={collectionProposal:{accountIds:p.accounts,deferredAccountIds:p.deferredAccounts},accounts:p.queries.flatMap(q=>q.accountIds.map(accountId=>({accountId,earliestCutoffAt:q.cutoffAt})))};
 assert.equal(validatePlan(p,a),p);
 for(const edit of [p=>p.budget.detailRequests=1,p=>p.queries[0].cutoffAt='2026-09-06T00:00:00.000Z',p=>p.queries[0].maxHttpAttemptsIncludingRetry=3,p=>p.accounts[0]='999']){const bad=structuredClone(p);edit(bad);assert.throws(()=>validatePlan(bad,a));}
});

test('all successful source rows retained; global bigint dedup does not inflate maps',async()=>{
 const p=fixture(),saved=[];
 const records=await collectQueries(p,async(q,i)=>observation(q,[row(q.accountIds[0],undefined,i)]),r=>saved.push(r));
 const report=summarizeDiscovery(p,records,['9007199254740993']);
 assert.equal(saved.length,2);assert.equal(report.counts.accountMapRows,2);assert.equal(report.counts.uniqueMaps,1);
 assert.equal(report.counts.knownInFrozenCapture,1);assert.equal(report.maps[0].matchId,'9007199254740993');assert.equal(report.deployable,false);
});

test('429 stops the batch and distinguishes unknown account history from successful empty results',async()=>{
 const p=fixture();let calls=0;const records=await collectQueries(p,async()=>{calls++;throw new OpenDotaError('source_rate_limited',null,429,60000);},()=>{});
 const r=summarizeDiscovery(p,records);assert.equal(calls,1);assert.deepEqual(r.accounts.map(a=>a.rows),[null,null]);
 assert.deepEqual(r.accounts.map(a=>a.status),['unavailable','not_attempted']);
 const empty=await collectQueries(p,async q=>observation(q,[]),()=>{});
 assert.deepEqual(summarizeDiscovery(p,empty).accounts.map(a=>a.rows),[0,0]);
});

test('filled page flags truncation; failure after first receipt preserves the successful query',async()=>{
 const p=fixture(),rows=Array.from({length:10},(_,i)=>({...row('10001',String(100-i)),start_time:1788000000-i}));
 const records=await collectQueries(p,async(q,i)=>{if(i)throw Error('private text must not escape');return observation(q,rows);},()=>{});
 const report=summarizeDiscovery(p,records);assert.equal(report.accounts[0].sourceLimitReached,true);assert.equal(report.accounts[1].rows,null);
 assert(!JSON.stringify(records).includes('private text'));assert.equal(report.counts.uniqueMaps,10);
});

test('conflicting map facts or duplicate participant slot remain visible, not merged into verified history',async()=>{
 const p=fixture();const records=await collectQueries(p,async(q,i)=>observation(q,[{...row(q.accountIds[0]),duration:i?2001:2000}]),()=>{});
 const result=summarizeDiscovery(p,records);assert.equal(result.counts.conflictedMaps,1);
 assert.deepEqual(result.maps[0].conflicts,['MAP_DURATION_CONFLICT','PLAYER_SLOT_CONFLICT']);
});

test('wrong account, changed SHA, boundary completion and non-pro discovery rows fail validation',()=>{
 const p=fixture(),q=p.queries[0];
 for(const bad of [observation(q,[row('999')]),observation(q,[{...row(),tier:'amateur'}]),
  observation(q,[{...row(),start_time:Math.floor(Date.parse(q.cutoffAt)/1000)-2000}]),
  {...observation(q,[]),rawBody:'{}'}])assert.throws(()=>validateObservation(bad,q));
});

test('attempt caps apply before shared quota and observe is forwarded without resetting limits',async()=>{
 let permits=0,observed=null;const shared={beforeRequest:async()=>{permits++;},observe:async(...args)=>{observed=args;}};
 const state={attempts:0,queryAttempts:0},budget=boundedBudget(shared,state);await budget.beforeRequest();assert.equal(permits,1);
 state.queryAttempts=2;await assert.rejects(budget.beforeRequest());assert.equal(permits,1);
 state.queryAttempts=0;state.attempts=18;await assert.rejects(budget.beforeRequest());assert.equal(permits,1);
 await budget.observe(429,60000,{minute:0,day:null,month:null});assert.equal(observed[0],429);
});

test('forged record order or unknown status cannot turn an unattempted query into an empty success',()=>{
 const p=fixture();
 for(const records of [[{index:0,status:'not_attempted'},{index:1,status:'not_attempted'}],
  [{index:0,status:'unavailable'},{index:1,status:'observed',observation:observation(p.queries[1],[])}],
  [{index:0,status:'other'},{index:1,status:'not_attempted'}]])assert.throws(()=>summarizeDiscovery(p,records));
});
