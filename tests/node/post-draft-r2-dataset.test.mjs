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

import {buildR2Dataset,assertEarlyParity,assertCodeCompatibility} from '../../tools/research/post-draft-r2-dataset.mjs';
function r2Fixture(recover=false,sqlKeyOrder=false){
 let f=fixture();
 if(recover){
  const target=f.capture.source.candidates.at(-1),hero=f.capture.heroes.at(-1);
  target.players=slots.map((slot,i)=>({playerSlot:slot,sourceAccountId:String(20001+i)}));target.receiptPlayers=structuredClone(target.players);
  hero.players.forEach((p,i)=>p.player_id=String(201+i));hero.receiptPlayers.forEach((p,i)=>p.account_id=20001+i);
  f.capture.source.identities.push(...f.capture.source.identities.slice(0,10).map((p,i)=>({...p,observationId:'new:'+i,playerId:String(201+i),externalAccountId:String(20001+i)})));
  f=seal(f.capture);
 }
 if(sqlKeyOrder){for(const h of f.capture.heroes)h.players=h.players.map(p=>({hero_id:p.hero_id,player_id:p.player_id,player_slot:p.player_slot}));f=seal(f.capture);}
 const baselineDataset=run(f),currentSource=structuredClone(f.capture.source),added=[],maps=[],groups=[];
 currentSource.request.snapshotAt='2026-11-13T02:00:00.000Z';currentSource.identityRevision='2';
 for(const m of currentSource.candidates)m.outcome.labelVerifiedAt=currentSource.request.snapshotAt;
 const target=currentSource.candidates.at(-1),targetHeroes=f.capture.heroes.at(-1);
 for(let i=0;i<(recover?5:1);i++){
  const id=String(11+i),m=structuredClone(target),date=`2026-08-${String(11+i).padStart(2,'0')}`;
  m.matchId=id;m.seriesId=`00000000-0000-4000-8000-${id.padStart(12,'0')}`;m.startedAtUs=micros(date+'T12:00:00.000Z');m.endedAtUs=micros(date+'T13:00:00.000Z');m.radiantWin=false;
  m.outcome={...m.outcome,matchId:id,seriesId:m.seriesId,outcomeReceiptId:id,teamAWon:false,startedAt:date+'T12:00:00.000Z',completedAt:date+'T13:00:00.000Z',sourceEvidence:{...m.outcome.sourceEvidence,receiptId:id,payloadSha256:'b'.repeat(64)}};
  added.push(m);currentSource.candidates.push(m);currentSource.aliases.push({seriesId:m.seriesId,provider:'opendota',providerSeriesId:id,teamAId:m.radiantTeamId,teamBId:m.direTeamId});
  maps.push({matchId:id,sourceSeriesId:id,reasons:[],projectionSha256:'b'.repeat(64),members:slots.map((slot,j)=>({slot,accountId:m.players[j].sourceAccountId,playerId:targetHeroes.players[j].player_id,heroId:j+1}))});
  groups.push({sourceSeriesId:id,knownMapIds:[id],reasons:[]});
 }
 const metadata=currentSource.candidates.map(m=>({matchId:m.matchId,seriesId:m.seriesId,startedAt:m.outcome.startedAt,completedAt:m.outcome.completedAt,dataRevision:m.dataRevision,
  seriesProvider:'opendota',sourceSeriesId:currentSource.aliases.find(a=>a.seriesId===m.seriesId).providerSeriesId,gameMode:'2',lobbyType:'1'}));
 return {protocol:f.protocol,baselineCapture:f.capture,baselineDataset,currentSource,metadata,importPlan:{maps,groups},
  importReport:{base:added.map(m=>({matchId:m.matchId})),outcomes:structuredClone(added.map(m=>m.outcome))},
  r2Plan:{fingerprint:'c'.repeat(64),targetLedger:{mapIds:f.capture.source.candidates.map(m=>m.matchId),count:f.capture.source.candidates.length,newHistoryIds:added.map(m=>m.matchId)},parameters:{coefficientFittingAllowed:false,calibrationFittingAllowed:false},evaluation:{independentTest:false}}};
}
const build=buildR2Dataset;
test('original SQL JSON key order is retained for frozen lineup byte hashes',()=>{
 const f=r2Fixture(false,true),r=build(f);assert.deepEqual(r.labels,f.baselineDataset.labels);assert.equal(r.earlyParity.train.status,'exact_except_declared_snapshot_provenance');
});
test('existing captured additive migrations are allowed but executable or historical SQL drift is refused',()=>{
 const old=[{path:'packages/db/dist/v1-data.js',sha256:'a'.repeat(64)}],migration={path:'packages/db/migrations/055_live_schedule.sql',sha256:'b'.repeat(64)};
 assert.equal(assertCodeCompatibility(old,[...old,migration]).originalFilesPreserved,1);
 assert.throws(()=>assertCodeCompatibility(old,[{...old[0],sha256:'c'.repeat(64)},migration]));
 assert.throws(()=>assertCodeCompatibility(old,[...old,{...migration,path:'packages/db/dist/new-runtime.js'}]));
 assert.throws(()=>assertCodeCompatibility(old,[...old,{...migration,path:'packages/db/migrations/058_unreviewed.sql'}]));
});
test('history-only additions preserve original targets, labels and early features with explicit new provenance',()=>{
 const f=r2Fixture(),before=JSON.stringify(f),r=build(f);assert.equal(JSON.stringify(f),before);
 assert.equal(r.rows.length,f.baselineDataset.rows.length);assert(!r.rows.some(x=>x.matchId==='11'));assert.deepEqual(r.labels,f.baselineDataset.labels);
 assert.equal(r.partitions.development_test.plannedDenominator,1);assert.equal(r.earlyParity.train.pairedMaps,f.baselineDataset.partitions.train.pairedMaps);
 assert.notEqual(r.rows.find(r=>r.matchId==='10').inputs.eloLogit,f.baselineDataset.rows.find(r=>r.matchId==='10').inputs.eloLogit);
 assert(r.labelReverifications.every(r=>r.originalVerifiedAt===snapshot&&r.reverifiedAt==='2026-11-13T02:00:00.000Z'));
 assert.equal(r.audit.targetScoring,false);assert.equal(r.deployable,false);assert.equal(r.targetLedger.remoteSeriesCompleteness,'unknown_not_inferred');
});
test('new eligible history recovers a target without adding it to training or inventing labels',()=>{
 const f=r2Fixture(true),r=build(f);assert.equal(f.baselineDataset.partitions.development_test.pairedMaps,0);assert.equal(r.partitions.development_test.pairedMaps,1);
 assert.deepEqual(r.comparison.development_test.recoveredIds,['10']);assert.equal(r.partitions.development_test.plannedDenominator,1);
 assert.equal(r.labels.find(x=>x.matchId==='10').verifiedAt,snapshot);assert.deepEqual(r.heroVocabulary,f.baselineDataset.heroVocabulary);
});
test('known history-only sibling across a split excludes the target series',()=>{
 const f=r2Fixture(),target=f.currentSource.candidates.find(m=>m.matchId==='10'),m=f.currentSource.candidates.find(m=>m.matchId==='11');
 m.seriesId=target.seriesId;m.outcome.seriesId=target.seriesId;
 const md=f.metadata.find(m=>m.matchId==='11');md.seriesId=target.seriesId;md.sourceSeriesId='10';
 f.importPlan.maps[0].sourceSeriesId='10';f.importPlan.groups[0]={sourceSeriesId:'10',knownMapIds:['10','11'],reasons:[]};
 const r=build(f),row=r.rows.find(m=>m.matchId==='10');assert(!row.pairedEligible);assert(row.reasons.includes('SERIES_CROSSES_BOUNDARY'));assert.deepEqual(r.comparison.development_test.lostIds,['10']);
});
test('duplicates, identity drift, original fact changes, new receipt/hero errors and missing siblings fail closed',()=>{
 for(const mutate of [f=>f.currentSource.candidates.push(f.currentSource.candidates[0]),f=>f.currentSource.identities[0].playerId='999',f=>f.currentSource.candidates[0].radiantWin=false,
  f=>f.importPlan.maps[0].projectionSha256='d'.repeat(64),f=>f.importPlan.maps[0].members[0].heroId=2,f=>f.importPlan.groups[0].knownMapIds.push('999'),f=>f.r2Plan.targetLedger.newHistoryIds.push('11'),f=>f.importReport.outcomes[0].teamAWon=true]){
  const f=r2Fixture();mutate(f);assert.throws(()=>build(f));
 }
});
test('equal-time completion and future additions do not enter target features',()=>{
 for(const future of [false,true]){
  const f=r2Fixture(),m=f.currentSource.candidates.find(m=>m.matchId==='11'),md=f.metadata.find(m=>m.matchId==='11'),o=f.importReport.outcomes[0];
  const end=future?'2026-09-04T13:00:00.000Z':'2026-09-03T12:00:00.000Z';
  m.endedAtUs=micros(end);m.outcome.completedAt=end;md.completedAt=end;o.completedAt=end;
  if(future){const start='2026-09-04T12:00:00.000Z';m.startedAtUs=micros(start);m.outcome.startedAt=start;md.startedAt=start;o.startedAt=start;}
  assert.deepEqual(build(f).rows.find(r=>r.matchId==='10').inputs,f.baselineDataset.rows.find(r=>r.matchId==='10').inputs);
 }
});
test('target outcome changes cannot change its features and cannot silently alter old labels',()=>{
 const f=r2Fixture(),before=build(f).rows.find(r=>r.matchId==='10').inputs;
 for(const source of [f.baselineCapture.source,f.currentSource]){const m=source.candidates.find(m=>m.matchId==='10');m.radiantWin=!m.radiantWin;m.outcome.teamAWon=m.radiantWin;}
 f.baselineDataset=buildPostDraftDataset(f.protocol,f.baselineCapture);
 assert.deepEqual(build(f).rows.find(r=>r.matchId==='10').inputs,before);
 const wrong=r2Fixture();wrong.currentSource.candidates.find(m=>m.matchId==='10').outcome.teamAWon=false;assert.throws(()=>build(wrong));
});
test('parity checks reject changed training features, eligibility, labels and vocabulary',()=>{
 const f=r2Fixture(),r=build(f);
 for(const mutate of [d=>d.rows.find(r=>r.partition==='train'&&r.pairedEligible).inputs.eloLogit++,d=>d.rows.find(r=>r.partition==='train').pairedEligible=false,
  d=>{const id=d.rows.find(r=>r.partition==='train'&&r.pairedEligible).matchId;d.labels.find(l=>l.matchId===id).teamAWon=!d.labels.find(l=>l.matchId===id).teamAWon;},d=>d.heroVocabulary.push(999)]){
  const changed=structuredClone(r);mutate(changed);assert.throws(()=>assertEarlyParity(f.baselineDataset,changed));
 }
});
