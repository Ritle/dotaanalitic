import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareAddedHistory} from '../../tools/research/post-draft-history-coverage.mjs';
import {diagnoseHistoryGaps} from '../../tools/research/post-draft-history-gaps.mjs';
const epoch=BigInt(Date.parse('2025-01-01T00:00:00Z'))*1000n,at=s=>(epoch+BigInt(s)*1000000n).toString();
function fixture(){
 const members=Array.from({length:10},(_,i)=>({playerId:String(9007199254741000n+BigInt(i)),accountId:String(1000+i)}));
 const map=(id,start)=>({matchId:id,seriesKey:'opendota:'+id,startedAtUs:at(start),completedAtUs:at(start+100),isPro:true,teamA:members.slice(0,5),teamB:members.slice(5),teamAWon:true,outcomeReceiptId:id,payloadSha256:'b'.repeat(64),fetchedAtUs:at(86400),labelVerifiedAtUs:at(86401),factClocks:[]});
 const before={schemaVersion:1,profile:'player-mean-elo-completed-strict-v1',sourceFingerprint:'a'.repeat(64),identityRevision:'1',snapshotAtUs:at(172800),warmupFromAtUs:at(0),syntheticOnly:true,
  identities:members.map(p=>({observationId:'proof:'+p.accountId,playerId:p.playerId,provider:'opendota',externalAccountId:p.accountId,status:'verified',eventAt:null,knownAt:null,fetchedAt:'2025-01-02T00:00:00.000Z',source:'synthetic',evidenceRef:'synthetic:'+p.accountId})),maps:[map('1',1000),map('2',2000),map('100',20000),map('101',25000)]};
 const targets=before.maps.slice(2).map(m=>({matchId:m.matchId,seriesKey:m.seriesKey,cutoffAtUs:m.startedAtUs,receiptId:m.outcomeReceiptId,radiantTeamId:'22',direTeamId:'9007199254740993'}));
 const gaps=diagnoseHistoryGaps(before,targets),current=structuredClone(before);current.maps.push(map('3',3000),map('4',4000),map('5',5000));
 const dataset=targets.map(t=>({matchId:t.matchId,seriesKey:t.seriesKey,nominalWindow:'development_test',pairedEligible:false,reasons:['INSUFFICIENT_PLAYER_HISTORY','SERIES_HAS_INELIGIBLE_DATASET_MAP']}));
 return {before,current,ids:['3','4','5'],gaps,dataset};
}
const run=f=>compareAddedHistory(f.before,f.current,f.ids,f.gaps,f.dataset);
test('exact additions close gaps without mutating frozen inputs or publishing predictions',()=>{
 const f=fixture(),copy=structuredClone(f),r=run(f);assert.deepEqual(f,copy);
 assert.equal(r.counts.deficientSlotsBefore,20);assert.equal(r.counts.deficientSlotsAfter,0);assert.equal(r.counts.summedDeficitBefore,50);assert.equal(r.counts.targetsMeetingMinimumAfter,2);
 assert.equal(r.fixedCohortCoverageOnly.upperBoundPaired,2);assert.equal(r.counts.provenHistoricalAvailableAddedLinks,0);assert.equal(r.targetProbabilitiesComputed,false);assert.equal(r.deployable,false);
 assert(r.rows[0].players.every(p=>p.afterMaps===5&&p.addedMatchIds.join(',')==='3,4,5'));
});
test('strict equality/future/ongoing maps do not contribute to an earlier target',()=>{
 const f=fixture();f.current.maps.find(m=>m.matchId==='3').completedAtUs=at(20000);f.current.maps.find(m=>m.matchId==='4').startedAtUs=at(20000);f.current.maps.find(m=>m.matchId==='4').completedAtUs=at(20100);f.current.maps.find(m=>m.matchId==='5').startedAtUs=at(30000);f.current.maps.find(m=>m.matchId==='5').completedAtUs=at(30100);
 const r=run(f);assert(r.rows[0].players.every(p=>p.afterMaps===2));assert(r.rows[1].players.every(p=>p.afterMaps===5));
});
test('whole-series independent blockers prevent row-level coverage from claiming dataset eligibility',()=>{
 const f=fixture();for(const r of f.dataset)r.seriesKey='opendota:shared';f.dataset.push({matchId:'999',seriesKey:'opendota:shared',nominalWindow:'development_test',pairedEligible:false,reasons:['INVENTORY_INELIGIBLE']});
 const r=run(f);assert.equal(r.counts.targetsMeetingMinimumAfter,2);assert.equal(r.fixedCohortCoverageOnly.upperBoundPaired,0);assert.deepEqual(r.fixedCohortCoverageOnly.recoveredIds,[]);
});
test('observed history and historical identity availability remain separate',()=>{
 const f=fixture();for(const m of f.current.maps.filter(m=>f.ids.includes(m.matchId))){m.fetchedAtUs=at(7000);m.labelVerifiedAtUs=at(7001);}
 assert.equal(run(f).counts.provenHistoricalAvailableAddedLinks,0);
 for(const e of f.current.identities)e.fetchedAt='2025-01-01T00:00:00.000Z';
 assert.equal(run(f).counts.provenHistoricalAvailableAddedLinks,60);
});
test('duplicates, stale baseline, changed minimum and identity conflicts fail closed',()=>{
 for(const change of [f=>f.ids.push('3'),f=>f.ids[0]='1',f=>f.current.maps.push(f.current.maps[0]),f=>f.gaps.rows[0].players[0].priorMaps++,f=>f.gaps.minimumPriorMaps=4,f=>f.current.identities.push({...f.current.identities[0],observationId:'conflict',playerId:'99'})]){
  const f=fixture();change(f);assert.throws(()=>run(f));
 }
});
test('native side swaps, target outcomes and new organizations cannot change per-account coverage',()=>{
 const f=fixture(),a=run(f);for(const m of f.current.maps.filter(m=>f.ids.includes(m.matchId))){[m.teamA,m.teamB]=[m.teamB,m.teamA];m.teamAWon=!m.teamAWon;}
 for(const h of [f.before,f.current])for(const m of h.maps.filter(m=>['100','101'].includes(m.matchId)))m.teamAWon=false;
 assert.deepEqual(run(f),a);
});
test('no added history and empty targets produce explicit zero deltas',()=>{
 const f=fixture();f.ids=[];const r=run(f);assert.equal(r.counts.summedDeficitBefore,r.counts.summedDeficitAfter);assert.equal(r.counts.improvedPlayerTargetSlots,0);
 f.gaps.rows=[];f.dataset=[];const empty=run(f);assert.equal(empty.counts.targetMaps,0);assert.equal(empty.fixedCohortCoverageOnly.coverage,null);
});
