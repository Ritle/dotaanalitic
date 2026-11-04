import {expect,test} from 'vitest';
import {resolveRoleProfiles} from '../src/role-profile-resolution.js';
import {buildRoleSuggestions} from '../src/role-suggestions.js';
import type {RoleProfileObservation,RoleProfilesReport,RoleSuggestionReport} from '@dota/contracts';
const now='2026-11-04T00:00:00.000Z',ids=['1','2','3','4','5'];
const history=():RoleSuggestionReport=>({...buildRoleSuggestions(ids,now,now,[],[],[]),players:ids.map((id,i)=>({playerId:id,suggestedRole:i+1,basis:'lane_gpm_estimate',
 nRaw:3,nUsed:3,topCount:3,lastMatchAt:now,reasons:[],distribution:[],evidence:[]}))});
const observations=():RoleProfilesReport['sources']=>ids.map((id,i)=>({provider:'stratz',sourceKey:'stratz:player:'+id,status:'ready',reason:null,fetchedAt:now,
 observation:{provider:'stratz',sourceKey:'stratz:player:'+id,fetchedAt:now,eventAt:null,knownAt:null,payloadSha256:'a'.repeat(64),
 players:[{accountId:id,providerPlayerId:id,providerTeamId:'10',name:'Synthetic',roles:[i+1]}]}}));
const run=(sources=observations(),global=history(),team=global)=>resolveRoleProfiles({teamId:'20',snapshotAt:now,configured:{enabled:true,stratz:true,pandascore:true},
 binding:{teamId:'20',revision:1,recordedAt:now,binding:{stratzTeamId:'10',pandaTeamId:'30',pandaTournamentId:'40',pandaPlayers:ids.map(id=>({playerId:id,providerPlayerId:String(100+Number(id))}))}},sources},
 global,team,ids.map(id=>({playerId:id,accountIds:[id],identityStatus:'verified'})));
test('matching current profile and selected-team history allow automatic unique positions',()=>{
 const r=run();expect(r.canAutoApply).toBe(true);expect(r.players.map(p=>p.rolePos)).toEqual([1,2,3,4,5]);
 expect(r.players.every(p=>p.historyScope==='selected_team')).toBe(true);
});
test('source disagreement, duplicate positions and stale/wrong-team profiles cannot auto apply',()=>{
 for(const patch of [{status:'stale' as const},{observation:{...observations()[0]!.observation!,players:[{...observations()[0]!.observation!.players[0]!,providerTeamId:'11'}]}}]){
   const sources=observations();sources[0]={...sources[0]!,...patch};expect(run(sources).canAutoApply).toBe(false);
 }
 const sources=observations();sources[0]!.observation!.players[0]!.roles=[2];
 const r=run(sources);expect(r.players[0]).toMatchObject({rolePos:null,basis:'conflict',autoEligible:false});
 expect(r.players[1]!.rolePos).toBe(2);
});
test('a single profile without history remains a manual suggestion; mixed roles never pick first arbitrarily',()=>{
 const h=buildRoleSuggestions(ids,now,now,[],[],[]);const r=run(observations(),h,h);
 expect(r.players[0]).toMatchObject({rolePos:1,basis:'profile_only',autoEligible:false});expect(r.canAutoApply).toBe(false);
 const sources=observations();sources[0]!.observation!.players[0]!.roles=[1,2];expect(run(sources,h,h).players[0]!.rolePos).toBeNull();
});
test('PandaScore uses explicit provider identity mapping, not name or equal-looking IDs',()=>{
 const observation:RoleProfileObservation={provider:'pandascore',sourceKey:'pandascore:roster:40',fetchedAt:now,eventAt:null,knownAt:null,payloadSha256:'b'.repeat(64),
 players:ids.map((id,i)=>({providerPlayerId:String(101+i),accountId:null,providerTeamId:'30',name:'Same nickname',roles:[i+1]}))};
 const source:RoleProfilesReport['sources'][number]={provider:'pandascore',sourceKey:observation.sourceKey,observation,status:'ready',reason:null,fetchedAt:now};
 expect(run([source]).canAutoApply).toBe(true);
 observation.players[0]!.providerPlayerId='1';expect(run([source]).players[0]!.basis).toBe('history_fallback');
});
test('selected organization roles take priority over previous organizations; two profiles agreeing can work without history',()=>{
 const old=history();old.players[0]!.suggestedRole=2;expect(run(observations(),old,history()).players[0]!.basis).toBe('agreement');
 const empty=buildRoleSuggestions(ids,now,now,[],[],[]),sources=observations();
 sources.push({provider:'pandascore',sourceKey:'pandascore:roster:40',status:'ready',reason:null,fetchedAt:now,observation:{provider:'pandascore',sourceKey:'pandascore:roster:40',
 fetchedAt:now,knownAt:null,eventAt:null,payloadSha256:'a'.repeat(64),players:ids.map((id,i)=>({providerPlayerId:String(101+i),accountId:null,providerTeamId:'30',name:null,roles:[i+1]}))}});
 expect(run(sources,empty,empty).canAutoApply).toBe(true);
});
