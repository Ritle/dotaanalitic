import {expect,it} from 'vitest';
import type {StoredAccountEvidence,StrengthProof} from '@dota/contracts';
import {buildStrengthReport,type StrengthCandidate} from '../src/strength-report.js';
const start='2024-01-01T12:00:00.000Z',end='2024-01-01T12:30:00.000Z',snapshot='2026-10-31T00:00:00.000Z';
const us=(s:string)=>String(BigInt(Date.parse(s))*1000n),ids=Array.from({length:10},(_,i)=>String(9007199254741001n+BigInt(i)));
const evidence=():StoredAccountEvidence[]=>ids.map((playerId,i)=>({observationId:String(i+1),playerId,externalAccountId:String(100+i),provider:'opendota',status:'verified',
  eventAt:null,knownAt:'2023-01-01T00:00:00.000Z',fetchedAt:snapshot,evidenceRef:'synthetic:historic-identity',source:'synthetic'}));
const lineup=ids.map((playerId,i)=>({playerSlot:i<5?i:i+123,playerId}));
const proof=(field:StrengthProof['field'],value:unknown,id:string):StrengthProof=>({id,field,value,eventAtUs:null,knownAtUs:us(end),fetchedAtUs:us(snapshot),evidenceRef:'synthetic:historic-availability',
  reviewState:'accepted',availability:'verified_asof',earliestStage:'post_match'});
const map=(change:Partial<StrengthCandidate>={}):StrengthCandidate=>({matchId:'1',startedAt:start,startedAtUs:us(start),endedAtUs:us(end),isPro:true,conflict:false,radiantWin:true,
  radiantTeamId:'11',direTeamId:'22',source:'synthetic',syncedAt:snapshot,dataRevision:'1',players:lineup.map((p,i)=>({playerSlot:p.playerSlot,sourceAccountId:String(100+i)})),
  proofs:[proof('pro_classification',{value:true},'1'),proof('radiant_win',true,'2'),proof('context.lineup',lineup,'3')],...change});
const query={fromAt:'2023-01-01T00:00:00.000Z',cutoffAt:'2024-02-01T00:00:00.000Z',limit:20};
const report=(maps=[map()],input=query,links=evidence())=>buildStrengthReport('11',input,snapshot,maps,links,'7');
it('strict identity and availability permit chronological retrospective audit, never a probability',()=>{
  const r=report();expect(r.summary).toMatchObject({nRaw:1,wins:1,winRate:1,ratedMaps:1,meanOpponentRatingBefore:1500,lastObservedFiveRating:1516});
  expect(r.maps[0]?.rating).toMatchObject({ownBefore:1500,change:16,lineupKnownBeforeStart:false});
  expect(r.teamAWinProbability).toBeNull();expect(r.policy.validation).toBe('unvalidated');expect(r.replayManifest).toHaveLength(1);
});
it('late or undated identity does not become historic from a completed map or cached IDs',()=>{
  for(const knownAt of [null,'2025-01-01T00:00:00.000Z']){const r=report([map()],query,evidence().map(p=>({...p,knownAt})));
    expect(r.summary).toMatchObject({nRaw:1,winRate:1,ratedMaps:0,lastObservedFiveRating:null});expect(r.coverage.identityUnavailable).toBe(1);}
});
it('unknown pro/outcome/lineup availability excludes ratings while raw organization results stay explicit',()=>{
  for(const field of ['pro_classification','radiant_win','context.lineup'] as const){const m=map();m.proofs=m.proofs.filter(p=>p.field!==field);
    const r=report([m]);expect(r.summary.ratedMaps).toBe(0);expect(r.coverage.evidenceUnavailable).toBe(1);expect(r.maps[0]?.rating).toBeNull();}
  const m=map();m.proofs=m.proofs.map(p=>({...p,availability:'retrospective_fact',knownAtUs:null}));expect(report([m]).summary.ratedMaps).toBe(0);
});
it('conflicts and mismatching native lineups fail closed; preknown lineup is separately marked',()=>{
  const m=map();m.proofs[2]!.reviewState='conflict';expect(report([m]).summary.ratedMaps).toBe(0);
  const pre=map();pre.proofs[2]={...pre.proofs[2]!,knownAtUs:us(start),earliestStage:'pre_match'};
  expect(report([pre]).maps[0]?.rating?.lineupKnownBeforeStart).toBe(true);
  pre.proofs[2]!.value=lineup.slice(1);expect(report([pre]).summary.ratedMaps).toBe(0);
});
it('pending labels do not update ratings or export a future outcome-derived delta',()=>{
  const m=map();m.proofs[1]!.knownAtUs=us('2025-01-01T00:00:00.000Z');const r=report([m]);
  expect(r.maps[0]?.rating).toMatchObject({updateApplied:false,change:null});expect(r.summary.ratedMaps).toBe(0);
  expect(r.coverage.pendingUpdates).toBe(1);expect(r.summary.meanRatingChange).toBeNull();
});
it('fromAt filters display only; old global maps still provide opponent warmup',()=>{
  const m=map({matchId:'2',startedAt:'2024-01-02T12:00:00.000Z',startedAtUs:us('2024-01-02T12:00:00.000Z'),endedAtUs:us('2024-01-02T12:30:00.000Z')});
  m.proofs=m.proofs.map(p=>({...p,knownAtUs:m.endedAtUs}));
  const r=report([map(),m],{...query,fromAt:'2024-01-02T00:00:00.000Z'});
  expect(r.summary.nRaw).toBe(1);expect(r.maps[0]?.rating?.ownBefore).toBe(1516);expect(r.coverage.globalReplayMaps).toBe(2);
  expect(report([m,map()],{...query,fromAt:'2024-01-02T00:00:00.000Z'}).replayManifest).toEqual(r.replayManifest);
});
it('pro-only/completion gates and strict start respect microsecond clocks',()=>{
  const r=report([map({isPro:null}),map({matchId:'2',isPro:false}),map({matchId:'3',conflict:true}),map({matchId:'4',endedAtUs:null})]);
  expect(r.coverage).toMatchObject({unknownPro:1,nonPro:1,conflict:1,unfinished:1});expect(r.summary.winRate).toBeNull();
  const futureEnd=String(BigInt(us(query.cutoffAt))+1n);expect(report([map({endedAtUs:futureEnd})]).summary.nRaw).toBe(0);
  expect(()=>report([map({startedAtUs:us(query.cutoffAt)})])).toThrow('candidate_outside_cutoff');
  expect(()=>report([map(),map()])).toThrow('duplicate_canonical_map');
});
it('duplicate same proof does not delay availability and an unrelated organization tag never seeds players',()=>{
  const m=map();m.proofs.push({...m.proofs[1]!,id:'4',knownAtUs:us('2025-01-01T00:00:00.000Z')});
  expect(report([m]).summary.ratedMaps).toBe(1);
  const r=buildStrengthReport('33',query,snapshot,[map()],evidence(),'7');expect(r.summary).toMatchObject({nRaw:0,winRate:null,ratedMaps:0,lastObservedFiveRating:null});
});
it('later conflicting evidence cannot rewrite opponent strength from before the correction',()=>{
  const first=map(),second=map({matchId:'2',startedAt:'2024-01-02T12:00:00.000Z',startedAtUs:us('2024-01-02T12:00:00.000Z'),endedAtUs:us('2024-01-02T12:30:00.000Z')});
  second.proofs=second.proofs.map(p=>({...p,knownAtUs:second.endedAtUs}));
  first.proofs.push({...first.proofs[1]!,id:'9',value:false,knownAtUs:us('2025-01-01T00:00:00.000Z')});
  const beforeConflict=report([first,second]);expect(beforeConflict.replayStoppedAtUs).toBeNull();expect(beforeConflict.maps[0]?.rating?.ownBefore).toBe(1516);
  const r=report([first,second],{...query,cutoffAt:'2026-01-01T00:00:00.000Z'});
  expect(r.maps[0]?.rating?.ownBefore).toBe(1516);expect(r.summary.lastObservedFiveRating).toBeNull();
  expect(r.warnings).toContain('RATING_STOPPED_AT_PROOF_CONFLICT');
  const later=map({matchId:'3',startedAt:'2025-02-01T12:00:00.000Z',startedAtUs:us('2025-02-01T12:00:00.000Z'),endedAtUs:us('2025-02-01T12:30:00.000Z')});
  later.proofs=later.proofs.map(p=>({...p,knownAtUs:later.endedAtUs}));
  expect(report([first,second,later],{...query,cutoffAt:'2026-01-01T00:00:00.000Z'}).maps[0]?.rating).toBeNull();
});
