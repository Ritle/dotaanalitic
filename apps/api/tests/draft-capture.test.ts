import {test,expect} from 'vitest';
import {captureDraftPlayers} from '../src/modules/scenarios/draft-capture-players.js';
import {scenarioInput} from '../../../tests/helpers/scenario.js';
import {DraftCaptureRequestSchema,type DraftCaptureIdentity} from '../src/modules/scenarios/draft-capture-contract.js';
const input=()=>{const s=scenarioInput();s.draft={assignments:(['A','B'] as const).flatMap((teamSlot,j)=>
  Array.from({length:5},(_,i)=>({teamSlot,rolePos:i+1,heroId:j*5+i+1}))),bans:[]};return s;};
const evidence=():DraftCaptureIdentity[]=>[...input().lineupA,...input().lineupB].map((p,i)=>({
  observationId:'proof:'+i,playerId:p.playerId!,externalAccountId:String(100+i),provider:'opendota',status:'verified',
  eventAt:null,knownAt:null,fetchedAt:'2026-11-01T00:00:00.000Z',evidenceRef:'synthetic:test',source:'synthetic'}));
test('binds player to hero by team and role, not transport order or Radiant',()=>{
  const s=input();s.lineupA.reverse();s.lineupB.reverse();s.draft!.assignments.reverse();s.context.radiantSlot='B';
  const result=captureDraftPlayers(s,evidence());expect(result.map(p=>p.heroId)).toEqual([1,2,3,4,5,6,7,8,9,10]);
  expect(result.map(p=>p.accountId)).toEqual(Array.from({length:10},(_,i)=>String(100+i)));
});
test('conflicting people or multiple accounts remain ambiguous; missing evidence stays null',()=>{
  const e=evidence();e.push({...e[0]!,observationId:'proof:other',playerId:e[1]!.playerId});
  expect(captureDraftPlayers(input(),e)[0]).toMatchObject({accountId:null,identityStatus:'ambiguous'});
  const many=evidence();many.push({...many[0]!,observationId:'proof:second',externalAccountId:'999'});
  expect(captureDraftPlayers(input(),many)[0]!.accountId).toBeNull();
  expect(captureDraftPlayers(input(),[]).every(p=>p.identityStatus==='missing')).toBe(true);
});
test('explicit rejection cannot be overridden by another provider and duplicate provider proof is not another account',()=>{
  const e=evidence();e.push({...e[0]!,provider:'stratz',observationId:'proof:stratz'});
  expect(captureDraftPlayers(input(),e)[0]!.accountId).toBe('100');
  e.push({...e[0]!,status:'rejected',observationId:'proof:reject'});
  expect(captureDraftPlayers(input(),e)[0]!.accountId).toBeNull();
});
test('partial draft preserves absence and transport cannot provide clock/history/probability',()=>{
  const s=input();s.draft!.assignments.pop();expect(captureDraftPlayers(s,evidence())[9]!.heroId).toBeNull();
  for(const key of ['decisionCutoffAt','history','teamAWinProbability','target','identityEvidence'])
    expect(DraftCaptureRequestSchema.safeParse({expectedRevision:1,[key]:null}).success).toBe(false);
});
