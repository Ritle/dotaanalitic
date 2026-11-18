import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recoveryPlan,mergeRecovery} from '../../tools/research/post-draft-history-quota-resume.mjs';
const fixture=()=>({parent:{httpAttempts:{total:3},counts:{localReviewed:0},rows:[{matchId:'1',status:'observed',receipt:{proof:'original'}},
 {matchId:'2',status:'unavailable',reason:'source_http_error'},{matchId:'3',status:'unavailable',reason:'source_rate_limited',retryAfterMs:60000},{matchId:'4',status:'not_attempted'}]},
 ids:['1','2','3','4'],attempts:[{matchId:'1'},{matchId:'2'},{matchId:'2'}]});
test('only the quota refusal before HTTP and untouched remainder may resume',()=>{
 const f=fixture(),p=recoveryPlan(f.parent,f.ids,f.attempts);assert.deepEqual(p.mapIds,['3','4']);assert.equal(p.alreadySpent,3);assert.equal(p.maxNewAttempts,97);
 f.attempts.push({matchId:'3'});f.parent.httpAttempts.total++;assert.throws(()=>recoveryPlan(f.parent,f.ids,f.attempts));
});
test('a timeout/HTTP failure cannot masquerade as unused quota; total attempts cannot reset',()=>{
 const f=fixture();f.parent.rows[2].reason='source_http_error';assert.throws(()=>recoveryPlan(f.parent,f.ids,f.attempts));
 const g=fixture();g.parent.httpAttempts.total=0;assert.throws(()=>recoveryPlan(g.parent,g.ids,g.attempts));
});
test('new success preserves previous quota event and parent bytes without replacing old successes',()=>{
 const f=fixture(),before=JSON.stringify(f.parent),p=recoveryPlan(f.parent,f.ids,f.attempts);
 const r=mergeRecovery(f.parent,p,p.mapIds.map(matchId=>({matchId,status:'observed',receipt:{}})),()=>({sourceConsistent:true,sourceReasons:[],coverageReasons:[]}),2);
 assert.equal(JSON.stringify(f.parent),before);assert.equal(r.rows[2].priorState.retryAfterMs,60000);assert.equal(r.httpAttempts.total,5);assert.equal(r.counts.unavailableRemoteTotal,1);assert.equal(r.deployable,false);
});
test('recovery cannot exceed remaining global attempts or report success after a new failure',()=>{
 const f=fixture(),p=recoveryPlan(f.parent,f.ids,f.attempts);assert.throws(()=>mergeRecovery(f.parent,p,[],()=>({}),98));
 assert.throws(()=>mergeRecovery(f.parent,p,[{matchId:'3',status:'unavailable'},{matchId:'4',status:'observed'}],()=>({}),2));
});
