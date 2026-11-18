import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildPostDraftDataset,sha} from '../../tools/research/post-draft-dataset.mjs';
import {buildPostDraftPlan} from '../../tools/research/post-draft-plan.mjs';
const policy=JSON.parse(readFileSync(new URL('../../tools/research/post-draft-policy.json',import.meta.url),'utf8'));
const micros=t=>(BigInt(Date.parse(t))*1000n).toString();
const fetched='2026-11-11T00:00:00.000Z',snapshot='2026-11-13T00:00:00.000Z';
const dates=['2024-01-01','2024-01-02','2024-01-03','2024-01-04','2024-01-05','2025-01-01','2025-01-02','2026-05-03','2026-07-03','2026-09-03'];
const slots=[0,1,2,3,4,128,129,130,131,132];
function fixture(){
 const players=slots.map((slot,i)=>({playerSlot:slot,sourceAccountId:String(10001+i)}));
 const candidates=dates.map((date,i)=>{
  const id=String(i+1),seriesId=`00000000-0000-4000-8000-${id.padStart(12,'0')}`,startedAt=date+'T12:00:00.000Z',completedAt=date+'T13:00:00.000Z';
  return {matchId:id,seriesId,startedAtUs:micros(startedAt),endedAtUs:micros(completedAt),syncedAtUs:micros(fetched),dataRevision:'1',
   isPro:true,ingestState:'accepted',radiantWin:i%3!==1,radiantTeamId:'9007199254740993',direTeamId:'22',players:structuredClone(players),receiptPlayers:structuredClone(players),seriesSourceMatched:true,facts:[],
   outcome:{status:'verified',matchId:id,outcomeReceiptId:id,teamAId:'9007199254740993',teamBId:'22',teamAWon:i%3!==1,startedAt,completedAt,seriesId,dataRevision:'1',labelVerifiedAt:snapshot,
    sourceEvidence:{receiptId:id,payloadSha256:'a'.repeat(64),adapterVersion:'synthetic',normalizerVersion:'synthetic',receiptFetchedAt:fetched}}};
 });
 const source={request:{schemaVersion:1,profile:'pre-match-player-elo-data-v1',purpose:'development_only',fromAt:policy.history.warmupFrom,toAt:policy.windows.at(-1).until,snapshotAt:snapshot,maxMaps:5000},
  identityRevision:'1',candidates,aliases:candidates.map(m=>({seriesId:m.seriesId,provider:'opendota',providerSeriesId:m.matchId,teamAId:m.radiantTeamId,teamBId:m.direTeamId})),
  identities:players.map((p,i)=>({observationId:'proof:'+i,playerId:String(101+i),provider:'opendota',externalAccountId:p.sourceAccountId,status:'verified',eventAt:null,knownAt:fetched,fetchedAt:fetched,evidenceRef:'synthetic:'+i,source:'synthetic-only'})),
  code:[{path:'synthetic:code',sha256:'b'.repeat(64)}],syntheticOnly:true};
 const heroes=candidates.map(m=>({matchId:m.matchId,dataRevision:'1',players:slots.map((slot,i)=>({player_slot:slot,hero_id:i+1,player_id:String(101+i)})),
  receiptId:m.matchId,sourceSha256:'a'.repeat(64),receiptPlayers:slots.map((slot,i)=>({player_slot:slot,hero_id:i+1,account_id:10001+i}))}));
 const input={source,heroes};return seal(input);
}
function seal({source,heroes}){
 const metadata=source.candidates.map(m=>({matchId:m.matchId,seriesId:m.seriesId,startedAt:new Date(Number(BigInt(m.startedAtUs)/1000n)).toISOString(),completedAt:new Date(Number(BigInt(m.endedAtUs)/1000n)).toISOString(),dataRevision:m.dataRevision,seriesProvider:'opendota',sourceSeriesId:source.aliases.find(a=>a.seriesId===m.seriesId).providerSeriesId,gameMode:'2',lobbyType:'1'}));
 const body={policyVersion:'post-draft-readiness-inventory-v1',trainingReady:false,deployable:false,maps:metadata.map(m=>({matchId:m.matchId,startedAt:m.startedAt,dataRevision:m.dataRevision,lineupSha256:sha(JSON.stringify([...heroes.find(h=>h.matchId===m.matchId).players].sort((a,b)=>a.player_slot-b.player_slot))),sourceSha256:'a'.repeat(64),researchInventoryCandidate:true}))};
 const plan=buildPostDraftPlan({...body,fingerprint:sha(JSON.stringify(body))},metadata,policy),registered={registeredAt:'2026-11-12T22:03:10.595Z',...plan};
 const protocol={...registered,fingerprint:sha(JSON.stringify(registered))};
 return {protocol,capture:{format:'post-draft-capture-v1',protocolFingerprint:protocol.fingerprint,source,heroes}};
}
const run=f=>buildPostDraftDataset(f.protocol,f.capture);
test('verified outcomes are separate, organization bigint orientation maps Dire heroes and labels correctly',()=>{
 const f=fixture(),before=JSON.stringify(f),d=run(f),r=d.rows.find(r=>r.matchId==='6');
 assert.equal(JSON.stringify(f),before);assert.equal(d.deployable,false);assert.equal(d.syntheticOnly,true);assert.equal(r.baselineEligible,true);
 assert.equal(r.featureSnapshot.teamASide,'dire');assert.equal(r.featureSnapshot.teamAId,'22');
 assert.deepEqual(r.inputs.signedHeroes.map(h=>h.value),[-1,-1,-1,-1,-1,1,1,1,1,1]);
 assert.equal(d.labels.find(l=>l.matchId==='6').teamAWon,!f.capture.source.candidates[5].radiantWin);
 assert.equal(r.featureSnapshot.elo.coverage.minimumPlayerMaps,5);assert.equal('label' in r,false);
 assert(!JSON.stringify(r.inputs).match(/teamAWon|radiantWin|completedAt|duration|kills|gpm/));
});
test('target and later outcomes cannot alter target inputs; earlier completed outcome can',()=>{
 const f=fixture(),a=run(f).rows.find(r=>r.matchId==='7').inputs;
 for(const index of [6,9]){const m=f.capture.source.candidates[index];m.radiantWin=!m.radiantWin;m.outcome.teamAWon=m.radiantWin;}
 assert.deepEqual(run(f).rows.find(r=>r.matchId==='7').inputs,a);
 const m=f.capture.source.candidates[0];m.radiantWin=!m.radiantWin;m.outcome.teamAWon=m.radiantWin;
 assert.notEqual(run(f).rows.find(r=>r.matchId==='7').inputs.eloLogit,a.eloLogit);
});
test('equal-time completion is excluded; target rejects fewer than five prior completed maps',()=>{
 const f=fixture(),m=f.capture.source.candidates[4],target=f.capture.source.candidates[5];m.endedAtUs=target.startedAtUs;m.outcome.completedAt=target.outcome.startedAt;
 const d=run(seal(f.capture)),r=d.rows.find(r=>r.matchId==='6');assert.equal(r.baselineEligible,false);assert(r.reasons.includes('INSUFFICIENT_PLAYER_HISTORY'));
});
test('train-only vocabulary never learns a hero from validation/calibration/test',()=>{
 const f=fixture(),h=f.capture.heroes[7];h.players[0].hero_id=99;h.receiptPlayers[0].hero_id=99;
 const d=run(seal(f.capture)),r=d.rows.find(r=>r.matchId==='8');assert(!d.heroVocabulary.includes(99));assert(r.baselineEligible);assert(!r.pairedEligible);
 assert(r.reasons.includes('HERO_OUTSIDE_TRAIN_VOCABULARY'));assert.equal(d.partitions.validation.plannedDenominator,1);
});
test('whole target series excludes a bad sibling without removing valid independent history',()=>{
 const f=fixture(),a=f.capture.source.candidates[5],b=f.capture.source.candidates[6];b.seriesId=a.seriesId;b.outcome.seriesId=a.seriesId;
 b.outcome={status:'unavailable',matchId:b.matchId,reasons:['SOURCE_CONFLICT']};const d=run(seal(f.capture));
 assert(d.rows.filter(r=>['6','7'].includes(r.matchId)).every(r=>!r.baselineEligible&&r.reasons.includes('SERIES_HAS_INELIGIBLE_DATASET_MAP')));
 assert(d.rows.find(r=>r.matchId==='8').featureSnapshot.elo.history.usedMatchIds.includes('6'));
});
test('duplicates, changed revision, lineup, receipt and alias are refused',()=>{
 const mutations=[f=>f.capture.heroes.push(f.capture.heroes[0]),f=>f.capture.heroes[0].dataRevision='2',f=>f.capture.heroes[0].players[0].hero_id=99,
  f=>f.capture.heroes[5].sourceSha256='c'.repeat(64),f=>f.capture.source.aliases[0].providerSeriesId='999'];
 for(const mutate of mutations){const f=fixture();mutate(f);assert.throws(()=>run(f));}
});
test('duplicate heroes, wrong source account and canonical identity never enter paired cohort',()=>{
 for(const mutation of [h=>{h.players[0].hero_id=2;h.receiptPlayers[0].hero_id=2;},h=>{h.receiptPlayers[0].account_id=123;},h=>{h.players[0].player_id='999';}]){
  const f=fixture();mutation(f.capture.heroes[5]);const d=run(seal(f.capture)),r=d.rows.find(r=>r.matchId==='6');assert(!r.pairedEligible);assert(r.reasons.some(x=>/HERO|IDENTITY/.test(x)));
 }
});
test('empty corpus has no invented rates, examples or heroes; arbitrary extra payload fields are rejected',()=>{
 const f=fixture();f.capture.source.candidates=[];f.capture.source.aliases=[];f.capture.heroes=[];const d=run(seal(f.capture));
 assert.equal(d.rows.length,0);assert.deepEqual(d.heroVocabulary,[]);assert.equal(d.partitions.train.pairedCoverage,null);
 assert.equal(d.dataChecks.status,'insufficient');assert(d.dataChecks.reasons.includes('DEVELOPMENT_TEST_COVERAGE_BELOW_0_80'));
 const bad=fixture();bad.capture.heroes[0].guessedWinner=true;assert.throws(()=>run(bad));
});
test('source ordering and player array order do not change deterministic features or rows',()=>{
 const f=fixture(),a=run(f);f.capture.source.candidates.reverse();f.capture.heroes.reverse();
 for(const h of f.capture.heroes){h.players.reverse();h.receiptPlayers.reverse();}
 for(const m of f.capture.source.candidates){m.players.reverse();m.receiptPlayers.reverse();}
 assert.deepEqual(run(f),a);
});
test('swapping actual Radiant/Dire sides preserves organization-oriented features and labels',()=>{
 const f=fixture(),a=run(f),flip=slot=>slot<128?slot+128:slot-128;
 for(const m of f.capture.source.candidates){
  [m.radiantTeamId,m.direTeamId]=[m.direTeamId,m.radiantTeamId];m.radiantWin=!m.radiantWin;
  [m.outcome.teamAId,m.outcome.teamBId]=[m.outcome.teamBId,m.outcome.teamAId];m.outcome.teamAWon=m.radiantWin;
  for(const p of [...m.players,...m.receiptPlayers])p.playerSlot=flip(p.playerSlot);
 }
 for(const h of f.capture.heroes)for(const p of [...h.players,...h.receiptPlayers])p.player_slot=flip(p.player_slot);
 const b=run(seal(f.capture));assert.deepEqual(b.rows.map(r=>r.inputs),a.rows.map(r=>r.inputs));
 assert.deepEqual(b.labels.map(l=>[l.matchId,l.teamAWon]),a.labels.map(l=>[l.matchId,l.teamAWon]));
});
