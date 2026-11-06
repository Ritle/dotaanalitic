import {describe,it,expect} from 'vitest';
import {preparedTeamView,preferredHistoryCandidate} from '../src/roster-preparation';
import type {RosterCataloguePrepared} from '@dota/contracts';
const team=(n=5,status:'linked'|'suggested'|'ambiguous'='linked'):RosterCataloguePrepared['teams'][number]=>({providerTeamId:'70',players:Array.from({length:n},(_,i)=>({providerPlayerId:String(100+i),name:`Player ${i}`,linkToken:'a'.repeat(64),status,candidates:[{id:String(1000+i),name:`Account ${i}`,localPlayerId:String(2000+i),teamId:null,teamName:null}]}))});
describe('prepared roster selection',()=>{
 it('suggests a sole verified local candidate with pro maps, but keeps ties and discoveries unresolved',()=>{
  const t=team(),a={...t.players[0]!.candidates[0]!,proMaps:0},b={...t.players[1]!.candidates[0]!,proMaps:5};
  expect(preferredHistoryCandidate([a,b])?.id).toBe(b.id);
  expect(preferredHistoryCandidate([{...a,proMaps:1},b])).toBeNull();
  expect(preferredHistoryCandidate([{...b,discovery:true}])).toBeNull();
  expect(preferredHistoryCandidate([{...b,localPlayerId:undefined}])).toBeNull();
 });
 it('permits automatic reuse only for five previously linked, verified local accounts',()=>{
  const t=team(),v=preparedTeamView(t,Object.fromEntries(t.players.map(p=>[p.providerPlayerId,p.candidates[0]!])),t.players.map(p=>p.providerPlayerId));
  expect(v.canUse).toBe(true);expect(v.canAutoUse).toBe(true);
 });
 it('keeps a unique nickname candidate behind an explicit whole-five review',()=>{
  const t=team(5,'suggested'),v=preparedTeamView(t,Object.fromEntries(t.players.map(p=>[p.providerPlayerId,p.candidates[0]!])),t.players.map(p=>p.providerPlayerId));
  expect(v.canUse).toBe(true);expect(v.canAutoUse).toBe(false);expect(v.message).toContain('Проверьте');
 });
 it('requires choosing five of six and never infers which one is a reserve',()=>{
  const t=team(6),choices=Object.fromEntries(t.players.map(p=>[p.providerPlayerId,p.candidates[0]!]));
  expect(preparedTeamView(t,choices,[]).message).toContain('6 игроков');
  const v=preparedTeamView(t,choices,t.players.slice(0,5).map(p=>p.providerPlayerId));expect(v.canUse).toBe(true);expect(v.canAutoUse).toBe(false);
 });
 it('rejects duplicate accounts within the five and across the other selected team',()=>{
  const t=team(),choices=Object.fromEntries(t.players.map(p=>[p.providerPlayerId,p.candidates[0]!])),ids=t.players.map(p=>p.providerPlayerId);
  expect(preparedTeamView(t,choices,ids,['1000']).canUse).toBe(false);
  choices['101']=choices['100']!;expect(preparedTeamView(t,choices,ids).canUse).toBe(false);
 });
 it('shows ambiguity and excludes search-discovery suggestions from one-click selection',()=>{
  const t=team(5,'ambiguous');expect(preparedTeamView(t,{},t.players.map(p=>p.providerPlayerId)).message).toContain('аккаунты');
  t.players[0]!.candidates[0]!.discovery=true;const choices=Object.fromEntries(t.players.map(p=>[p.providerPlayerId,p.candidates[0]!]));
  expect(preparedTeamView(t,choices,t.players.map(p=>p.providerPlayerId)).canUse).toBe(false);
 });
});
