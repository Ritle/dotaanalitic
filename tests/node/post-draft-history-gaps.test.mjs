import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseHistoryGaps,historySeriesKey} from '../../tools/research/post-draft-history-gaps.mjs';

const base=BigInt(Date.parse('2025-01-01T00:00:00Z'))*1000n;
const at=s=>(base+BigInt(s)*1000000n).toString();
function fixture(n=3,two=false){
 const members=Array.from({length:10},(_,i)=>({playerId:String(9007199254741000n+BigInt(i)),accountId:String(1000+i)}));
 const map=(id,start)=>({matchId:id,seriesKey:'synthetic:'+id,startedAtUs:at(start),completedAtUs:at(start+100),isPro:true,
  teamA:members.slice(0,5),teamB:members.slice(5),teamAWon:true,outcomeReceiptId:id,payloadSha256:'b'.repeat(64),
  fetchedAtUs:at(86400),labelVerifiedAtUs:at(172800),factClocks:[]});
 const history={schemaVersion:1,profile:'player-mean-elo-completed-strict-v1',sourceFingerprint:'a'.repeat(64),identityRevision:'1',
  snapshotAtUs:at(172800),warmupFromAtUs:at(0),syntheticOnly:true,
  identities:members.map(p=>({observationId:'proof:'+p.accountId,playerId:p.playerId,provider:'opendota',externalAccountId:p.accountId,
   status:'verified',eventAt:null,knownAt:null,fetchedAt:'2025-01-02T00:00:00.000Z',source:'synthetic',evidenceRef:'synthetic:'+p.accountId})),
  maps:Array.from({length:n},(_,i)=>map(String(i+1),(i+1)*1000))};
 history.maps.push(map('100',20000));if(two)history.maps.push(map('101',25000));
 const targets=history.maps.filter(m=>['100','101'].includes(m.matchId)).map(m=>({matchId:m.matchId,seriesKey:m.seriesKey,
  cutoffAtUs:m.startedAtUs,receiptId:m.outcomeReceiptId,radiantTeamId:'9007199254740993',direTeamId:'22'}));
 return {history,targets};
}

test('uses verified stable accounts, strict prior IDs and bigint A/B orientation without mutation',()=>{
 const f=fixture(),before=structuredClone(f),r=diagnoseHistoryGaps(f.history,f.targets);
 assert.deepEqual(f,before);assert.equal(r.rows[0].teamASide,'dire');assert.equal(r.rows[0].players[0].accountId,'1005');
 assert(r.rows[0].players.every(p=>p.priorMaps===3&&p.missingToMinimum===2&&p.priorMatchIds.join(',')==='1,2,3'));
 assert.equal(r.counts.distinctDeficientAccounts,10);assert.equal(r.counts.summedSlotDeficit,20);
 assert.equal(r.collectionProposal.summedDeficitIsNotUniqueMissingMaps,true);assert.equal(r.providerHttpRequests,0);assert.equal(r.deployable,false);
});

test('same account across targets is deduplicated; earlier target only contributes after its completion',()=>{
 const f=fixture(3,true),r=diagnoseHistoryGaps(f.history,f.targets);
 assert.equal(r.accounts.length,10);assert.equal(r.counts.deficientPlayerMapSlots,20);
 for(const a of r.accounts){assert.deepEqual(a.targets.map(t=>t.priorMaps),[3,4]);assert.equal(a.requiredBeforeEarliestCutoff,2);}
 assert.equal(r.collectionProposal.maxDiscoveryAttempts,20);assert.equal(r.collectionProposal.maxTotalHttpAttempts,120);
});

test('equal-time completion and future maps are excluded, target outcomes do not affect gaps',()=>{
 const f=fixture(4,true);f.history.maps[3].completedAtUs=at(20000);
 const a=diagnoseHistoryGaps(f.history,[f.targets[0]]);
 assert(a.rows[0].players.every(p=>p.priorMaps===3));
 f.history.maps.find(m=>m.matchId==='100').teamAWon=false;f.history.maps.at(-1).teamAWon=false;
 assert.deepEqual(diagnoseHistoryGaps(f.history,[f.targets[0]]),a);
});

test('swapping native sides preserves per-account counts and changes A-side assignment',()=>{
 const f=fixture(),a=diagnoseHistoryGaps(f.history,f.targets);
 for(const m of f.history.maps){[m.teamA,m.teamB]=[m.teamB,m.teamA];m.teamAWon=!m.teamAWon;}
 for(const t of f.targets)[t.radiantTeamId,t.direTeamId]=[t.direTeamId,t.radiantTeamId];
 const b=diagnoseHistoryGaps(f.history,f.targets);assert.equal(b.rows[0].teamASide,'radiant');assert.deepEqual(b.accounts,a.accounts);
});

test('zero observed history stays zero; empty target list creates no request',()=>{
 const f=fixture(0),a=diagnoseHistoryGaps(f.history,f.targets);
 assert(a.rows[0].players.every(p=>p.priorMaps===0&&p.missingToMinimum===5&&p.priorMatchIds.length===0));
 const b=diagnoseHistoryGaps(f.history,[]);assert.deepEqual(b.accounts,[]);assert.equal(b.collectionProposal.maxDiscoveryAttempts,0);
});

test('duplicates, stale receipts/cutoffs and identity conflicts fail closed',()=>{
 for(const change of [f=>f.history.maps.push(f.history.maps[0]),f=>f.targets.push(f.targets[0]),
  f=>f.targets[0].receiptId='999',f=>f.targets[0].cutoffAtUs=at(22000),
  f=>f.history.identities.push({...f.history.identities[0],observationId:'conflict',playerId:'42'})]){
  const f=fixture();change(f);assert.throws(()=>diagnoseHistoryGaps(f.history,f.targets));
 }
});

test('ready target cannot be relabelled a history gap; ordering cannot change results',()=>{
 const ready=fixture(5);assert.throws(()=>diagnoseHistoryGaps(ready.history,ready.targets));
 const f=fixture(3,true),a=diagnoseHistoryGaps(f.history,f.targets);f.history.maps.reverse();f.targets.reverse();f.history.identities.reverse();
 assert.deepEqual(diagnoseHistoryGaps(f.history,f.targets),a);
});

test('dataset tuple and feature-history namespace bind the same verified series without numeric precision loss',()=>{
 assert.equal(historySeriesKey('["opendota","9007199254740993"]'),'opendota:9007199254740993');
 for(const key of ['["other","1"]','["opendota",1]','["opendota","01"]','["opendota","1","extra"]'])assert.throws(()=>historySeriesKey(key));
 const f=fixture(),map=f.history.maps.find(m=>m.matchId==='100');map.seriesKey='opendota:1138399';
 f.targets[0].seriesKey=map.seriesKey;f.targets[0].datasetSeriesKey='["opendota","1138399"]';
 assert.equal(diagnoseHistoryGaps(f.history,f.targets).rows[0].datasetSeriesKey,f.targets[0].datasetSeriesKey);
 f.targets[0].datasetSeriesKey='["opendota","1138400"]';assert.throws(()=>diagnoseHistoryGaps(f.history,f.targets));
});
