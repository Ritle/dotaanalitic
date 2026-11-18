import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildSeriesFeatures} from '../../tools/research/series-development-core.mjs';
const base=BigInt(Date.parse('2025-01-01T00:00:00.000Z'))*1000n;
const at=s=>(base+BigInt(s)*1000000n).toString();
function fixture(n=5){
  const people=Array.from({length:10},(_,i)=>({playerId:String(9007199254741000n+BigInt(i)),accountId:String(1000+i)}));
  const make=(matchId,seriesKey,start,end)=>({matchId,seriesKey,startedAtUs:at(start),completedAtUs:at(end),isPro:true,
    teamA:people.slice(0,5),teamB:people.slice(5),teamAWon:true,outcomeReceiptId:matchId,payloadSha256:'b'.repeat(64),
    fetchedAtUs:at(86400),labelVerifiedAtUs:at(172800),factClocks:[]});
  const history={schemaVersion:1,profile:'player-mean-elo-completed-strict-v1',sourceFingerprint:'a'.repeat(64),identityRevision:'1',
    snapshotAtUs:at(172800),warmupFromAtUs:at(0),syntheticOnly:true,
    identities:people.map(p=>({observationId:'synthetic:'+p.accountId,playerId:p.playerId,provider:'opendota',externalAccountId:p.accountId,
      status:'verified',eventAt:null,knownAt:null,fetchedAt:'2025-01-02T00:00:00.000Z',source:'synthetic',evidenceRef:'synthetic:'+p.accountId})),
    maps:[...Array.from({length:n},(_,i)=>make(String(i+1),'history:'+i,(i+1)*1000,(i+1)*1000+100)),make('100','target',8000,8500),make('101','target',10000,10500)]};
  const target={seriesKey:'target',mapIds:['100','101'],firstMapId:'100',cutoffAtUs:at(8000),teamA:people.slice(0,5),teamB:people.slice(5),
    lineupSource:'synthetic:receipt:100',selectedAtUs:at(86400)};
  return {history,target,make};
}
test('reuses fixed Elo trajectory with five earlier maps and never issues a probability',()=>{
  const {history,target}=fixture(),r=buildSeriesFeatures(history,target);let a=1500,b=1500;
  for(let i=0;i<5;i++){const d=32*(1-1/(1+10**((b-a)/400)));a+=d;b-=d;}
  assert.equal(r.status,'ready');assert(Math.abs(r.features.teamAMeanElo-a)<1e-10);assert.equal(r.coverage.minimumPlayerMaps,5);
  assert.deepEqual(r.history.usedMatchIds,['1','2','3','4','5']);assert.equal(r.teamAWinProbability,null);assert.equal(r.deployable,false);
});
test('changing target and later map outcomes cannot change any feature-result bytes',()=>{
  const {history,target,make}=fixture();history.maps.push(make('200','future',12000,12500));const before=buildSeriesFeatures(history,target);
  for(const m of history.maps.filter(m=>['100','101','200'].includes(m.matchId)))m.teamAWon=false;
  history.sourceFingerprint='c'.repeat(64);assert.deepEqual(buildSeriesFeatures(history,target),before);
});
test('even an erroneously earlier sibling is excluded by series key, not just listed IDs',()=>{
  const {history,target,make}=fixture(),before=buildSeriesFeatures(history,target);history.maps.push(make('99','target',6500,6600));
  assert.deepEqual(buildSeriesFeatures(history,target),before);
});
test('ongoing, exact-cutoff and future maps are removed before any eligibility checks',()=>{
  const {history,target,make}=fixture(),before=buildSeriesFeatures(history,target);
  history.maps.push(make('201','equal',7000,8000),make('202','ongoing',7100,8100),make('203','future',9000,9500));
  assert.deepEqual(buildSeriesFeatures(history,target),before);
});
test('an ineligible future sibling cannot erase an earlier history map of another series',()=>{
  const {history,target,make}=fixture(),before=buildSeriesFeatures(history,target),later=make('201','history:0',9000,9500);
  later.teamA=[{playerId:'777',accountId:'777'},...later.teamA.slice(1)];history.maps.push(later);
  assert.deepEqual(buildSeriesFeatures(history,target),before);
});
test('A/B swap changes feature sign without assuming radiant/dire',()=>{
  const {history,target}=fixture(),a=buildSeriesFeatures(history,target),b=buildSeriesFeatures(history,{...target,teamA:target.teamB,teamB:target.teamA});
  assert.equal(a.features.eloDifference,-b.features.eloDifference);assert.equal(a.features.teamAMeanElo,b.features.teamBMeanElo);
});
test('no history and small history remain unavailable; no fabricated 1500 experience',()=>{
  for(const n of [0,4]){const {history,target}=fixture(n),r=buildSeriesFeatures(history,target);assert.equal(r.status,'unavailable');assert.equal(r.features,null);
    assert(r.reasons.includes('INSUFFICIENT_PLAYER_HISTORY'));if(n===0)assert(r.teamA.every(p=>p.rating===null));}
});
test('ten verified unique identities are mandatory',()=>{
  const {history,target}=fixture();history.identities=history.identities.filter(p=>p.externalAccountId!=='1000');
  assert(buildSeriesFeatures(history,target).reasons.includes('IDENTITY_UNVERIFIED'));
  const duplicate=fixture();duplicate.target.teamA[0]=duplicate.target.teamB[0];assert.throws(()=>buildSeriesFeatures(duplicate.history,duplicate.target));
});
test('wrong cutoff, missing first map, wrong key and duplicate member-map IDs are rejected',()=>{
  for(const mutate of [t=>t.cutoffAtUs=at(9000),t=>t.firstMapId='999',t=>t.seriesKey='other',t=>t.mapIds.push('100')]){
    const {history,target}=fixture();mutate(target);assert.throws(()=>buildSeriesFeatures(history,target));}
});
test('source input is not mutated and native bigint identities stay strings',()=>{
  const {history,target}=fixture(),saved=structuredClone({history,target});const r=buildSeriesFeatures(history,target);
  assert.deepEqual({history,target},saved);assert.equal(r.teamA[0].playerId,'9007199254741000');
});
