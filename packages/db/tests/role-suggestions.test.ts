import {expect,test} from 'vitest';
import {buildRoleSuggestions,estimateLaneRoles,type RoleLaneRow,type RoleLaneEvidence} from '../src/role-suggestions.js';
import type {ProMapCandidate} from '../src/pro-maps.js';
import type {StoredAccountEvidence} from '@dota/contracts';
const cutoff='2026-11-04T00:00:00.000Z',start='2026-11-01T00:00:00.000Z';
const raw=(base:0|128=0):RoleLaneRow[]=>[1,2,3,3,1].map((laneRole,i)=>({playerSlot:base+i,accountId:String(100+i),laneRole,gpm:[600,700,500,300,250][i]!}));
const proofs:StoredAccountEvidence[]=Array.from({length:5},(_,i)=>({observationId:'proof:'+i,playerId:String(i+1),externalAccountId:String(100+i),provider:'opendota',status:'verified',
  eventAt:null,knownAt:null,fetchedAt:cutoff,evidenceRef:'synthetic:account',source:'synthetic'}));
const map=(id='1',base:0|128=0):ProMapCandidate=>({matchId:id,startedAt:start,isPro:true,conflict:false,completed:true,radiantWin:true,durationSeconds:1800,
  radiantTeamId:'1',direTeamId:'2',leagueId:null,seriesId:null,source:'synthetic',syncedAt:cutoff,sourceFetchedAt:cutoff,dataRevision:'1',
  observations:[],players:raw(base).map(p=>({playerSlot:p.playerSlot,sourceAccountId:p.accountId,gpm:p.gpm}))});
const lane=(id='1',base:0|128=0):RoleLaneEvidence=>({matchId:id,receiptId:id,fetchedAt:cutoff,players:raw(base)});
const report=(maps=[map()],lanes=[lane()],evidence=proofs)=>buildRoleSuggestions(['1','2','3','4','5'],cutoff,cutoff,maps,evidence,lanes);
test('2-1-2 lanes distinguish cores/supports by farm; native Dire slots and ordering do not change roles',()=>{
  expect([...estimateLaneRoles(raw(),0).entries()].sort()).toEqual([[0,1],[1,2],[2,3],[3,4],[4,5]]);
  expect(report([map('1',128)],[lane('1',128)]).players.map(p=>p.suggestedRole)).toEqual([1,2,3,4,5]);
  const r=raw().reverse();expect(estimateLaneRoles(r,0).get(0)).toBe(1);
});
test('missing farm or tie abstains for a lane; roaming/missing/duplicate slots are not five known positions',()=>{
  const r=raw();r[0]!.gpm=250;expect(estimateLaneRoles(r,0).has(0)).toBe(false);expect(estimateLaneRoles(r,0).get(1)).toBe(2);
  r[2]!.gpm=null;expect(estimateLaneRoles(r,0).has(2)).toBe(false);
  r[4]!.laneRole=4;expect(estimateLaneRoles(r,0).size).toBe(0);
  expect(estimateLaneRoles(raw().slice(1),0).size).toBe(0);const duplicate=raw();duplicate[4]!.playerSlot=0;expect(estimateLaneRoles(duplicate,0).size).toBe(0);
});
test('one canonical map is one vote despite duplicate receipts; provenance/low N/heuristic explicit',()=>{
  const r=report([map()],[lane(),{...lane(),receiptId:'2'}]);expect(r.status).toBe('ready');
  expect(r.players[0]).toMatchObject({nRaw:1,nUsed:1,topCount:1,basis:'lane_gpm_estimate',reasons:['SMALL_SAMPLE','UNVALIDATED_HEURISTIC']});
  expect(r.players[0]!.evidence[0]!.proofIds).toEqual(['receipt:1','receipt:2']);expect(r.model).toBeNull();
  expect(()=>report([map(),map()])).toThrow('duplicate_role_map');
});
test('public/unknown/conflicting/unfinished maps, exact cutoff and late end cannot vote; zero is unknown',()=>{
  for(const patch of [{isPro:false},{isPro:null},{conflict:true},{completed:false},{startedAt:cutoff},
    {startedAt:'2026-11-03T23:59:59.999Z'},{startedAt:'2025-01-01T00:00:00.000Z'}]){
    const p=report([{...map(),...patch}]).players[0]!;expect(p).toMatchObject({nRaw:0,nUsed:0,suggestedRole:null,basis:'unknown'});
  }
});
test('unverified or conflicting canonical identities never use cached projection or nickname',()=>{
  expect(report([map()],[lane()],proofs.slice(1)).players[0]!.suggestedRole).toBeNull();
  expect(report([map()],[lane()],[...proofs,{...proofs[0]!,observationId:'conflict',playerId:'2'}]).players.every(p=>p.suggestedRole===null)).toBe(true);
  const duplicate=map();duplicate.players[4]!.sourceAccountId='100';expect(report([duplicate]).players.every(p=>p.nUsed===0)).toBe(true);
});
test('changed roles require a strict majority, opposing receipts abstain, and fresh fetch is not historical known-at',()=>{
  const a=lane('2');[a.players[0]!.gpm,a.players[4]!.gpm]=[250,600];const b=map('2');[b.players[0]!.gpm,b.players[4]!.gpm]=[250,600];
  expect(report([map(),b],[lane(),a]).players[0]!.suggestedRole).toBeNull();
  const conflicting=lane();conflicting.players[0]!.laneRole=3;
  expect(report([map()],[lane(),conflicting]).players[0]!.nUsed).toBe(0);
  expect(report([map()],[{...lane(),fetchedAt:'2026-11-05T00:00:00.000Z'}]).players[0]!.nUsed).toBe(0);
  expect(report().warnings).toContain('CURRENT_RECONSTRUCTION_NOT_HISTORICAL_AVAILABILITY');
});
test('recent 20 maps are bounded before role availability, rather than finding arbitrarily old evidence',()=>{
  const maps=Array.from({length:25},(_,i)=>map(String(i+1)));const r=report(maps,maps.map(m=>lane(m.matchId)));
  expect(r.players[0]!.nRaw).toBe(20);expect(r.players[0]!.nUsed).toBe(20);
  expect(r.players[0]!.evidence.map(e=>e.matchId)).toEqual(Array.from({length:20},(_,i)=>String(25-i)));
});
test('confirmed historical roles override estimates; duplicate or explicitly conflicting claims abstain',()=>{
  const m=map();m.observations=[{id:'role:1',matchId:'1',fact:{field:'roles',value:[{playerSlot:0,playerId:'1',rolePos:3,basis:'confirmed',confidence:1}]},
    eventAt:null,knownAt:null,fetchedAt:cutoff,evidenceRef:'synthetic:role',provider:'synthetic',providerRecordId:null,adapterVersion:'synthetic',
    reviewState:'accepted',availability:'retrospective_fact',earliestStage:'post_match'}];
  expect(report([m]).players[0]).toMatchObject({suggestedRole:3,basis:'confirmed_history'});
  m.observations[0]!.reviewState='conflict';expect(report([m]).players[0]!.suggestedRole).toBeNull();
  m.observations[0]!.reviewState='accepted';const fact=m.observations[0]!.fact;
  if(fact.field==='roles')fact.value!.push({playerSlot:2,playerId:'3',rolePos:3,basis:'confirmed',confidence:1});
  expect(report([m]).players[0]!.suggestedRole).toBeNull();
});
