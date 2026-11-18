import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateContinuation,mergeContinuation,checkSequence,validateReceiptAttempts} from '../../tools/research/post-draft-history-continuation.mjs';
import {collectDetails,detailBudget} from '../../tools/research/post-draft-history-details.mjs';
import {OpenDotaError} from '../../packages/ingestion/dist/index.js';
const assessment=()=>({sourceConsistent:true,sourceReasons:[],coverageReasons:['CANONICAL_IDENTITY_UNKNOWN'],trainingEligible:false});
function fixture(){
 const rows=Array.from({length:95},(_,i)=>({matchId:String(i+1),status:i<6?'observed':i===6?'unavailable':'not_attempted',...(i<6?{receipt:{source:{attempts:1}},assessment:assessment()}:{} )}));
 const attempts=[...rows.slice(0,6),rows[6],rows[6]].map(r=>({matchId:r.matchId,response:{status:r.status==='observed'?200:500}}));
 const parent={rows,counts:{plannedRemote:95,localReviewed:0},httpAttempts:8};
 const plan={status:'draft_not_registered_not_executed',deployable:false,mapIds:rows.slice(7).map(r=>r.matchId),reuseWithoutHttp:rows.slice(0,6).map(r=>r.matchId),deferredExhaustedMapIds:['7'],
  parentManifestSha256:'a'.repeat(64),parentReportSha256:'b'.repeat(64),budget:{alreadySpent:8,originalGlobalMaxHttpAttempts:100,maxNewHttpAttemptsIncludingRetries:92,maxAttemptsPerMapAcrossRuns:2,
   extraDiscoveryRequests:0,profileRequests:0,catalogueRequests:0,businessWrites:0}};
 return {plan,parent,attempts};
}
test('remaining set is exact and ordered; successful and exhausted maps cannot enter a continuation',()=>{
 const f=fixture();assert.equal(validateContinuation(f.plan,f.parent,f.attempts),f.plan);
 for(const edit of [p=>p.mapIds[0]='1',p=>p.mapIds[0]='7',p=>p.mapIds.reverse(),p=>p.reuseWithoutHttp=[],p=>p.deferredExhaustedMapIds=[]]){
  const p=structuredClone(f.plan);edit(p);assert.throws(()=>validateContinuation(p,f.parent,f.attempts));
 }
});
test('budget cannot be reset, widened or hide historical attempts',()=>{
 const f=fixture();for(const edit of [p=>p.budget.alreadySpent=0,p=>p.budget.maxNewHttpAttemptsIncludingRetries=100,p=>p.budget.maxAttemptsPerMapAcrossRuns=3,p=>p.budget.profileRequests=1]){
  const p=structuredClone(f.plan);edit(p);assert.throws(()=>validateContinuation(p,f.parent,f.attempts));
 }
 assert.throws(()=>validateContinuation(f.plan,f.parent,f.attempts.slice(1)));
 const a=structuredClone(f.attempts);a[0].matchId='8';assert.throws(()=>validateContinuation(f.plan,f.parent,a));
 a[0].matchId='7';assert.throws(()=>validateContinuation(f.plan,f.parent,a));
});
test('existing quota guard initialized at eight permits only remaining 92 attempts',async()=>{
 const state={attempts:8,mapAttempts:0};let permits=0;
 const budget=detailBudget({beforeRequest:async()=>{permits++;},observe:async()=>{}},state);
 for(let i=0;i<92;i++){state.mapAttempts=0;await budget.beforeRequest();state.attempts++;}
 assert.equal(permits,92);assert.equal(state.attempts,100);await assert.rejects(budget.beforeRequest());assert.equal(permits,92);
});
test('partial continuation preserves parent receipts and does not call after Retry-After failure',async()=>{
 const f=fixture(),before=JSON.stringify(f.parent),saved=[];let calls=0;
 const rows=await collectDetails(f.plan.mapIds,async()=>{if(calls++===1)throw new OpenDotaError('source_rate_limited',null,429,60000);return {source:{attempts:1}};},r=>saved.push(r));
 const report=mergeContinuation(f.plan,f.parent,rows,assessment,2);
 assert.equal(calls,2);assert.equal(saved.length,88);assert.equal(rows[1].retryAfterMs,60000);
 assert.deepEqual(report.httpAttempts,{previous:8,new:2,total:10});assert.equal(report.counts.observedRemoteTotal,7);
 assert.equal(report.counts.unavailableRemoteTotal,2);assert.equal(report.counts.notAttemptedRemoteTotal,86);
 assert.equal(JSON.stringify(f.parent),before);assert.deepEqual(report.rows[0].receipt,f.parent.rows[0].receipt);
 assert.equal(report.rows[0].collectedIn,'parent');assert.equal(report.rows[7].collectedIn,'continuation');assert.equal(report.deployable,false);
});
test('completed continuation still retains the previously failed map and immutable local reviews',()=>{
 const f=fixture();f.parent.rows.push({matchId:'9007199254740993',status:'observed',assessment:assessment(),receipt:{basis:'normalized_local_receipt'}});f.parent.counts.localReviewed=1;
 const records=f.plan.mapIds.map(matchId=>({matchId,status:'observed',receipt:{source:{attempts:1}}}));
 const r=mergeContinuation(f.plan,f.parent,records,assessment,88);
 assert.equal(r.status,'completed_continuation');assert.equal(r.counts.observedRemoteTotal,94);assert.equal(r.counts.unavailableRemoteTotal,1);assert.equal(r.httpAttempts.total,96);
 assert.equal(r.rows.at(-1).matchId,'9007199254740993');assert.equal(r.counts.localReviewed,1);assert.equal(r.importedMaps,0);
 assert.throws(()=>mergeContinuation(f.plan,f.parent,records,assessment,0));assert.throws(()=>mergeContinuation(f.plan,f.parent,records,assessment,93));
});
test('false emptiness, reordered rows and successes after failure cannot be replayed',()=>{
 const ids=['1','2'];for(const rows of [[{matchId:'1',status:'not_attempted'},{matchId:'2',status:'not_attempted'}],
  [{matchId:'1',status:'unavailable'},{matchId:'2',status:'observed'}],[{matchId:'2',status:'observed'},{matchId:'1',status:'observed'}]])assert.throws(()=>checkSequence(ids,rows));
});
test('observed receipt must bind to successful HTTP and its retry count; unattempted maps have zero requests',()=>{
 const f=fixture();validateReceiptAttempts(f.parent.rows,f.attempts);
 const a=structuredClone(f.attempts);a[0].response.status=500;assert.throws(()=>validateReceiptAttempts(f.parent.rows,a));
 const b=structuredClone(f.parent.rows);b[0].receipt.source.attempts=2;assert.throws(()=>validateReceiptAttempts(b,f.attempts));
 assert.throws(()=>validateReceiptAttempts(f.parent.rows,[...f.attempts,{matchId:'8',response:{status:200}}]));
});
