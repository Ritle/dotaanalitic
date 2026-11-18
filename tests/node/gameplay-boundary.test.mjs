import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeGameplayClocks as audit} from '../../tools/audits/gameplay-boundary-core.mjs';
const fixture=()=>({ids:['123'],local:[{matchId:'123',payload:{start_time:1000,duration:500}}],
 opendota:[{match_id:123,start_time:1000,duration:500,pre_game_duration:90,draft_timings:[],pauses:[{time:20,duration:30}],
 players:[{obs_log:[{time:-55},{time:10}],sen_log:[{time:-1}]}]}],
 stratz:{data:{m0:{id:123,startDateTime:1000,endDateTime:1500,durationSeconds:500},t0:{name:'MatchType',fields:[{name:'startDateTime',description:null,type:{name:'Long'}}]}}}});
test('equal provider clocks, pregame=90 and end-duration do not establish UTC gameplay',()=>{
 const r=audit(fixture());assert.equal(r.items[0].stratz.endMinusStartMinusDuration,0);assert.equal(r.items[0].openDota.pauseSeconds,30);
 assert.equal(r.items[0].observedActionsBeforeGameClockZero,true);assert.equal(r.counts.verifiedGameplayStarts,0);assert.equal(r.teamAWinProbability,null);
 assert.equal(r.collectionAllowed,false);assert.equal(r.primaryEligible,false);
});
test('empty draft timings and absent fields remain different, neither proves final-draft time',()=>{
 const f=fixture();assert.equal(audit(f).items[0].openDota.draftTimingRows,0);delete f.opendota[0].draft_timings;delete f.opendota[0].pauses;
 const r=audit(f).items[0];assert.equal(r.openDota.draftTimingRows,null);assert.equal(r.openDota.pauseSeconds,null);assert.equal(r.verifiedDraftCompletedAt,null);
});
test('timed draft rows are relative evidence, not an invented wall-clock conversion',()=>{
 const f=fixture();f.opendota[0].draft_timings=[{time:-400},{time:-130}];const r=audit(f);
 assert.equal(r.counts.mapsWithDraftTimingRows,1);assert.equal(r.items[0].openDota.draftRowsWithTime,2);assert.equal(r.items[0].verifiedDraftCompletedAt,null);
});
test('missing providers and local proof do not become zero durations or confirmations',()=>{
 const f=fixture();f.opendota=[];f.stratz=null;f.local=[];const r=audit(f).items[0];
 assert.equal(r.openDota.durationSeconds,null);assert.equal(r.stratz.endMinusStartMinusDuration,null);assert.equal(r.agreement.start,null);
 assert.equal(r.openDota.observerWards.minimum,null);assert(r.reasons.includes('LOCAL_PRO_RECEIPT_MISSING'));
});
test('duplicate and foreign match ids or GraphQL errors reject the source',()=>{
 const f=fixture();f.opendota.push(f.opendota[0]);assert.throws(()=>audit(f));
 const g=fixture();g.stratz.data.m0.id=456;assert.throws(()=>audit(g));
 const h=fixture();h.stratz.errors=[{message:'synthetic'}];assert.throws(()=>audit(h));
});
test('malformed pause durations are unknown; negative times remain evidence and never shift start_time',()=>{
 const f=fixture();f.opendota[0].pauses[0].duration=-1;const r=audit(f).items[0];
 assert.equal(r.openDota.pauseSeconds,null);assert.equal(r.openDota.startTime,1000);assert.equal(r.openDota.observerWards.negative,1);
});
test('provider disagreement is preserved, source input is not mutated',()=>{
 const f=fixture();f.stratz.data.m0.startDateTime=999;const before=structuredClone(f),r=audit(f);
 assert.equal(r.items[0].agreement.start,false);assert.deepEqual(f,before);assert.equal(r.items[0].verifiedGameplayStartedAt,null);
});
