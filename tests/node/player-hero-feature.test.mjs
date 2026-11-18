import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlayerHeroFeatureBuilder,FEATURE_POLICY} from '../../.tools/s304-hero-feature-runtime/player-hero-feature.mjs';
const day=86400000000n,T=1800000000000000n,sha='a'.repeat(64);
function fixture(){
 const players=Array.from({length:10},(_,i)=>({playerId:String(i+1),accountId:String(i+101),heroId:i+1}));
 const map=(id,start,end,ps=players)=>({matchId:id,startedAtUs:String(start),completedAtUs:String(end),fetchedAtUs:String(T+day),knownAtUs:null,
  isPro:true,receiptSha256:sha,canonicalPatchId:null,players:structuredClone(ps)});
 return {history:{format:'verified-player-hero-history-v1',syntheticOnly:true,sourceSha256:sha,fromAtUs:String(T-200n*day),toAtUs:String(T+day),snapshotAtUs:String(T+2n*day),
  maps:[map('9007199254740993',T-day,T-day/2n)]},scenario:{targetMatchId:'9007199254740994',cutoffAtUs:String(T),teamA:players.slice(0,5),teamB:players.slice(5),
   canonicalPatchId:null,heroBasis:'reconstructed_final_receipt',selectedAtUs:String(T+day),sourceSha256:sha},map};
}
const run=f=>createPlayerHeroFeatureBuilder(f.history)(f.scenario);
test('fixed scalar is mean log1p volume difference, with raw counts and exact map lineage',()=>{
 const f=fixture();f.history.maps[0].players[0].heroId=20;const r=run(f);
 assert.equal(r.status,'computed_research_only');assert(Math.abs(r.feature+Math.log(2)/5)<1e-14);
 assert.equal(r.teamA[0].nRaw,0);assert.deepEqual(r.teamB[0].matchIds,['9007199254740993']);
 assert.deepEqual(r.featureOrder,['observedHeroPracticeLog90Delta']);assert.equal(FEATURE_POLICY.days,90);
 assert.equal(r.deployable,false);assert.equal(r.publicationEligible,false);assert.equal(r.scoringPerformed,false);
 assert.equal(r.teamB[0].knownBeforeCutoffMaps,0);assert(r.warnings.includes('HISTORY_AVAILABILITY_NOT_ESTABLISHED'));
});
test('unknown hero preserves missingness separately from an observed zero; no arbitrary penalty',()=>{
 const f=fixture();f.history.maps[0].players[0].heroId=null;const r=run(f);
 assert.equal(r.teamA[0].nRaw,0);assert.equal(r.teamA[0].heroUnknownMaps,1);
 assert.deepEqual(r.teamA[0].heroUnknownMatchIds,['9007199254740993']);assert(r.warnings.includes('HERO_HISTORY_INCOMPLETE'));
 const g=fixture();g.history.maps=[];const empty=run(g);assert.equal(empty.feature,0);assert(empty.warnings.includes('NO_OBSERVED_HERO_PRACTICE'));
 assert(empty.teamA.every(p=>p.priorProMaps===0&&p.nRaw===0&&p.heroUnknownMaps===0));
});
test('start boundary inclusive, completion cutoff strict; target and overlapping/future maps excluded',()=>{
 const f=fixture();const players=f.history.maps[0].players;
 f.history.maps=[f.map('1',T-90n*day,T-89n*day),f.map('2',T-90n*day-1n,T-89n*day),f.map('3',T-day,T),
  f.map('4',T-day,T+1n),f.map('5',T,T+day/2n),f.map(f.scenario.targetMatchId,T-day,T-day/2n,players)];
 const r=run(f);assert(r.teamA.concat(r.teamB).every(p=>p.nRaw===1&&p.matchIds.join()==='1'));
});
test('incomplete source window returns null scalar, never averages a silently shortened window',()=>{
 const f=fixture();f.history.fromAtUs=String(T-10n*day);let r=run(f);assert.equal(r.feature,null);assert.equal(r.teamAMean,null);
 assert.deepEqual(r.reasons,['HISTORY_WINDOW_START_TRUNCATED']);
 f.history.fromAtUs=String(T-200n*day);f.history.toAtUs=String(T-1n);r=run(f);assert.equal(r.status,'unavailable');assert(r.reasons.includes('HISTORY_WINDOW_END_TRUNCATED'));
});
test('A/B swap negates feature; slot and input order never define sides',()=>{
 const f=fixture();f.history.maps[0].players[0].heroId=20;const r=run(f);
 [f.scenario.teamA,f.scenario.teamB]=[f.scenario.teamB,f.scenario.teamA];assert.equal(run(f).feature,-r.feature);
 [f.scenario.teamA,f.scenario.teamB]=[f.scenario.teamB,f.scenario.teamA];f.scenario.teamA.reverse();f.scenario.teamB.reverse();f.history.maps[0].players.reverse();
 assert.deepEqual(run(f),{...r,scenario:f.scenario});
});
test('no unverified cross-account merge even if canonical ID matches',()=>{
 const f=fixture();f.history.maps[0].players[0].accountId='999';assert.equal(run(f).teamA[0].nRaw,0);
});
test('unknown patches and roles stay warnings, not canonical/role inference or publication permission',()=>{
 const f=fixture();let r=run(f);assert.equal(r.teamA[0].sameCanonicalPatch,null);assert(r.warnings.includes('TARGET_CANONICAL_PATCH_UNKNOWN'));
 f.scenario.canonicalPatchId='99';r=run(f);assert.equal(r.teamA[0].sameCanonicalPatch,0);assert.equal(r.teamA[0].canonicalPatchUnknownMaps,1);
 assert(r.warnings.includes('ROLE_NOT_CONDITIONED'));assert.equal(r.publicationEligible,false);
});
test('known/fetched clocks are separate from completion and never backdated',()=>{
 const f=fixture();f.history.maps[0].knownAtUs=String(T-1n);let r=run(f);assert.equal(r.teamA[0].knownBeforeCutoffMaps,0);
 f.history.maps[0].fetchedAtUs=String(T-1n);r=run(f);assert.equal(r.teamA[0].knownBeforeCutoffMaps,1);
 f.history.maps[0].knownAtUs=String(T);assert.equal(run(f).teamA[0].knownBeforeCutoffMaps,0);
});
test('strict boundary rejects outcomes, stats, unknown fields, non-pro rows and invalid identity/hero/time',()=>{
 const changes=[f=>f.history.maps[0].isPro=false,f=>f.history.maps[0].outcome=true,f=>f.scenario.probability=.8,
  f=>f.history.maps.push(f.history.maps[0]),f=>f.scenario.teamA[0].heroId=null,f=>f.scenario.teamB[0].heroId=1,
  f=>f.scenario.teamB[0].playerId='1',f=>f.scenario.teamB[0].accountId='101',f=>f.history.maps[0].players[0].accountId='4294967295',
  f=>f.history.maps[0].completedAtUs=f.history.maps[0].startedAtUs,f=>f.history.maps[0].fetchedAtUs=String(T+3n*day),
  f=>f.scenario.teamA.pop(),f=>f.history.maps[0].players[0].heroId=NaN,f=>f.history.maps[0].players[0].accountId=101];
 for(const change of changes){const f=fixture();change(f);assert.throws(()=>run(f));}
});
test('builder and scenario are deterministic and do not mutate or retain mutable caller history',()=>{
 const f=fixture(),before=structuredClone({history:f.history,scenario:f.scenario}),builder=createPlayerHeroFeatureBuilder(f.history),r=builder(f.scenario);
 assert.deepEqual({history:f.history,scenario:f.scenario},before);f.history.maps=[];assert.deepEqual(builder(f.scenario),r);
 r.teamA[0].nRaw=999;assert.equal(builder(f.scenario).teamA[0].nRaw,1);
 assert.throws(()=>r.featureOrder.push('unregistered'));assert.equal(builder(f.scenario).featureOrder.length,1);
});
