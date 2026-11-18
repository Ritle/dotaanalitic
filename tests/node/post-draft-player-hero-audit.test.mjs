import test from 'node:test';
import assert from 'node:assert/strict';
import {bindHeroHistory,auditPlayerHeroCoverage} from '../../tools/research/post-draft-player-hero-audit.mjs';
const slots=[0,1,2,3,4,128,129,130,131,132];
const start=BigInt(Date.parse('2026-06-01T00:00:00Z'))*1000n,day=86400000000n;
function fixture(){
 const teamA=slots.slice(0,5).map((_,i)=>({playerId:String(i+1),accountId:String(i+101)}));
 const teamB=slots.slice(5).map((_,i)=>({playerId:String(i+6),accountId:String(i+106)}));
 const maps=[['9007199254740993',start-day,start-day/2n],['9007199254740994',start,start+day/2n]].map(([matchId,s,c])=>({
  matchId,seriesKey:'series:'+matchId,startedAtUs:String(s),completedAtUs:String(c),isPro:true,teamA,teamB,
  fetchedAtUs:String(start+2n*day),outcomeReceiptId:matchId,payloadSha256:'a'.repeat(64),teamAWon:true}));
 const source={candidates:maps.map(m=>({matchId:m.matchId,startedAtUs:m.startedAtUs,endedAtUs:m.completedAtUs,isPro:true,dataRevision:'1',
  outcome:{status:'verified'},players:[...teamA,...teamB].map((p,i)=>({playerSlot:slots[i],sourceAccountId:p.accountId}))}))};
 const heroes=maps.map(m=>({matchId:m.matchId,dataRevision:'1',receiptId:m.outcomeReceiptId,sourceSha256:m.payloadSha256,
  players:[...teamA,...teamB].map((p,i)=>({player_id:p.playerId,hero_id:i+1,player_slot:slots[i]})),
  receiptPlayers:[...teamA,...teamB].map((p,i)=>({account_id:Number(p.accountId),hero_id:i+1,player_slot:slots[i]}))}));
 const inventory=maps.map(m=>({matchId:m.matchId,sourceSha256:m.payloadSha256,dataRevision:'1',canonicalPatchId:null,providerPatchId:60}));
 const history={maps,syntheticOnly:true};
 const dataset={rows:[{matchId:maps[1].matchId,seriesKey:maps[1].seriesKey,nominalWindow:'train',pairedEligible:true,reasons:[],featureSnapshot:{cutoffAtUs:String(start)}}],partitions:{train:{plannedDenominator:1}}};
 return {history,source,heroes,inventory,dataset};
}
const run=f=>auditPlayerHeroCoverage(f.dataset,f.history,bindHeroHistory(f.history,f.source,f.heroes,f.inventory));
test('counts one prior pro map per verified account/hero, across organizations and slots',()=>{
 const f=fixture();f.source.candidates[0].radiantTeamId='other';f.heroes.forEach(h=>{h.players.reverse();h.receiptPlayers.reverse();});
 const before=structuredClone(f),r=run(f);assert.deepEqual(f,before);assert(r.syntheticOnly);
 assert.equal(r.rows[0].players.length,10);assert(r.rows[0].players.every(p=>p.nRaw===1&&p.nRecent90Days===1));
 assert.deepEqual(r.rows[0].players[0].priorMatchIds,['9007199254740993']);
 assert.equal(r.partitions.train.thresholds[0].allTenMaps,1);assert.equal(r.partitions.train.thresholds[1].allTenMaps,0);
 assert.equal(r.rows[0].players[0].sameProviderPatch,1);assert.equal(r.rows[0].players[0].sameCanonicalPatch,null);
 assert.equal(r.rows[0].players[0].sourceFetchedBeforeTarget,0);assert.equal(r.rows[0].players[0].knownAsOfHistory,null);
 assert.equal(r.trainingPerformed,false);assert.equal(r.scoringPerformed,false);assert.equal(r.deployable,false);
});
test('strict cutoff excludes equal completion and overlapping/future maps',()=>{
 for(const completion of [start,start+1n]){const f=fixture();f.history.maps[0].completedAtUs=String(completion);f.source.candidates[0].endedAtUs=String(completion);
  assert(run(f).rows[0].players.every(p=>p.nRaw===0&&p.priorProMaps===0&&p.lastPlayedAt===null));}
 const f=fixture();f.history.maps[0].startedAtUs=String(start+day);f.source.candidates[0].startedAtUs=String(start+day);
 f.history.maps[0].completedAtUs=String(start+2n*day);f.source.candidates[0].endedAtUs=String(start+2n*day);
 assert(run(f).rows[0].players.every(p=>p.nRaw===0));
});
test('90-day lower boundary is inclusive and no weighting is invented',()=>{
 const f=fixture();f.history.maps[0].startedAtUs=String(start-90n*day);f.source.candidates[0].startedAtUs=String(start-90n*day);
 assert.equal(run(f).rows[0].players[0].nRecent90Days,1);
 f.history.maps[0].startedAtUs=String(start-90n*day-1n);f.source.candidates[0].startedAtUs=String(start-90n*day-1n);
 const p=run(f).rows[0].players[0];assert.equal(p.nRaw,1);assert.equal(p.nRecent90Days,0);
});
test('missing or conflicting heroes remain incomplete history, not invented zero experience',()=>{
 const f=fixture();f.heroes[0].players[0].hero_id=null;
 const r=run(f);assert.equal(r.history.excluded[0].reason,'FINAL_HERO_RECEIPT_INVALID');
 assert(r.rows[0].players.every(p=>p.priorProMaps===1&&p.priorHeroUnknownMaps===1&&p.nRaw===0));
 f.heroes.shift();assert.equal(run(f).history.excluded[0].reason,'HERO_ROW_MISSING');
});
test('unknown patches do not match one another; provider patch is never canonical',()=>{
 const f=fixture();f.inventory.forEach(m=>m.providerPatchId=null);const r=run(f);
 assert(r.rows[0].players.every(p=>p.sameProviderPatch===null&&p.sameCanonicalPatch===null&&p.priorProviderPatchUnknown===1));
 assert.equal(r.partitions.train.sameProviderPatch.n,0);assert.equal(r.partitions.train.sameProviderPatch.median,null);
});
test('missing canonical identity in captured hero rows is a coverage exclusion',()=>{
 const f=fixture();f.heroes[0].players[0].player_id=null;
 const r=run(f);assert.deepEqual(r.history.excluded,[{matchId:f.history.maps[0].matchId,reason:'CANONICAL_HERO_IDENTITY_UNRESOLVED'}]);
 assert.equal(r.rows[0].players[0].priorHeroUnknownMaps,1);
});
test('no nickname merge or cross-account substitution',()=>{
 const f=fixture();f.history.maps[0]=structuredClone(f.history.maps[0]);f.history.maps[0].teamA[0].accountId='999';
 f.source.candidates[0].players[0].sourceAccountId='999';f.heroes[0].receiptPlayers[0].account_id=999;
 assert.equal(run(f).rows[0].players[0].nRaw,0);assert.equal(run(f).rows[0].players[1].nRaw,1);
});
test('rejects duplicate map/player/account, receipt/identity/source/time/pro boundary tampering',()=>{
 const changes=[f=>f.history.maps.push(f.history.maps[0]),f=>f.heroes.push(f.heroes[0]),
  f=>f.heroes[0].receiptId='999',f=>f.heroes[0].sourceSha256='b'.repeat(64),f=>f.heroes[0].players[0].player_id='999',
  f=>f.heroes[0].receiptPlayers[0].account_id=999,f=>f.source.candidates[0].isPro=false,
  f=>f.inventory[0].sourceSha256='b'.repeat(64),f=>f.source.candidates[0].endedAtUs='1',
  f=>{f.history.maps[0]=structuredClone(f.history.maps[0]);f.history.maps[0].teamA[0].playerId='2';},
  f=>{f.history.maps[0]=structuredClone(f.history.maps[0]);f.history.maps[0].teamA[0].accountId='102';}];
 for(const mutate of changes){const f=fixture();mutate(f);assert.throws(()=>run(f));}
});
test('fixed target denominator preserved, unavailable target and empty sample remain explicit',()=>{
 const f=fixture();f.dataset.rows[0].pairedEligible=false;f.dataset.rows[0].reasons=['ORIGINAL_EXCLUSION'];const r=run(f);
 assert.equal(r.partitions.train.plannedMaps,1);assert.equal(r.partitions.train.assessedMaps,0);assert.equal(r.rows[0].players,null);
 assert.equal(r.partitions.train.localAllHistory.median,null);
 f.dataset.rows[0].pairedEligible=true;f.heroes.pop();assert.throws(()=>run(f),/target_hero_missing/);
 const g=fixture();g.dataset.partitions.train.plannedDenominator=2;assert.throws(()=>run(g),/denominator_drift/);
});
test('target outcomes and model scores do not affect coverage; input ordering is irrelevant',()=>{
 const f=fixture(),r=run(f);f.history.maps[1].teamAWon=false;f.dataset.labels=[{teamAWon:false}];f.dataset.rows[0].inputs={eloLogit:999};
 f.history.maps.reverse();f.heroes.reverse();f.inventory.reverse();f.source.candidates.reverse();assert.deepEqual(run(f),r);
});
test('binds known series across explicit dataset/history encodings and rejects different series',()=>{
 const f=fixture();f.dataset.rows[0].seriesKey='["opendota","123"]';f.history.maps[1].seriesKey='opendota:123';
 assert.equal(run(f).partitions.train.assessedSeries,1);
 f.history.maps[1].seriesKey='opendota:124';assert.throws(()=>run(f));
});
