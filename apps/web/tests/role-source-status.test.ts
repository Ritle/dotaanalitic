import {expect,test} from 'vitest';
import type {RoleProfilesReport} from '@dota/contracts';
import {roleCandidateStatus,roleSourceStatus} from '../src/role-source-status';
type Player=RoleProfilesReport['players'][number];
const player:Player={playerId:'9007199254740993',accountIds:['1000'],identityStatus:'verified',rolePos:null,basis:'unknown',autoEligible:false,historyRole:null,historyMaps:0,historyScope:'all_organizations',candidates:[],reasons:[]};
const candidate={source:'stratz' as const,roles:[3],eligible:false,reason:'TEAM_BINDING_MISSING'};
const report=():Pick<RoleProfilesReport,'binding'|'sources'>=>({binding:{teamId:'1',revision:0,recordedAt:null,binding:{stratzTeamId:null,pandaTeamId:null,pandaTournamentId:null,pandaPlayers:[]}},sources:[{provider:'stratz',sourceKey:'stratz:player:1000',status:'ready',reason:null,fetchedAt:'2026-11-05T00:00:00.000Z',observation:{provider:'stratz',sourceKey:'stratz:player:1000',fetchedAt:'2026-11-05T00:00:00.000Z',knownAt:null,eventAt:null,payloadSha256:'a'.repeat(64),players:[{accountId:'1000',providerPlayerId:'1000',providerTeamId:null,name:null,roles:[3]}]}}]});
test('unknown team, absent pro profile and missing binding have different actions',()=>{
 const r=report();expect(roleCandidateStatus(r,player,candidate)).toContain('не указал команду');
 r.sources[0]!.observation!.players[0]!.providerTeamId='77';expect(roleCandidateStatus(r,player,candidate)).toContain('Сопоставление источников');
 r.binding.binding.stratzTeamId='78';expect(roleCandidateStatus(r,player,candidate)).toContain('другая команда');
 r.sources[0]!.observation!.players=[];expect(roleCandidateStatus(r,player,candidate)).toContain('не вернул профессиональный профиль');
 expect(roleSourceStatus(r.sources[0]!)).toContain('профиль не найден');
});
test('stale empty observations are not presented as current missing profiles',()=>{
 const r=report();r.sources[0]!.observation!.players=[];r.sources[0]!.status='stale';
 expect(roleCandidateStatus(r,player,candidate)).toContain('Данные устарели');
 expect(roleSourceStatus(r.sources[0]!)).not.toContain('профиль не найден');
});
test('cooldown and disabled sources do not invite immediate refresh loops',()=>{
 const s=report().sources[0]!;s.status='stale';
 for(const reason of ['cooldown','source_rate_limited','disabled','not_configured','refresh_in_progress']){
  s.reason=reason;expect(roleSourceStatus(s)).not.toContain('Нажмите');
 }
 s.status='unavailable';s.reason='not_loaded';expect(roleSourceStatus(s)).toContain('ещё не загружены');
 s.reason='source_schema_invalid';expect(roleSourceStatus(s)).toContain('позже');
});
test('display diagnostics never use another account, conflicting identity or mismatched observation',()=>{
 const r=report();r.sources[0]!.observation!.players[0]!.accountId='1001';
 expect(roleCandidateStatus(r,player,candidate)).not.toContain('не указал команду');
 expect(roleCandidateStatus(r,{...player,identityStatus:'conflict'},candidate)).toContain('подтвердите аккаунт');
 r.sources[0]!.observation!.sourceKey='stratz:player:1001';expect(roleCandidateStatus(r,player,candidate)).not.toContain('не указал команду');
});
test('eligible hints and report evidence remain unchanged',()=>{
 const r=report(),before=JSON.stringify(r);expect(roleCandidateStatus(r,player,{...candidate,eligible:true})).toBeNull();
 roleCandidateStatus(r,player,candidate);roleSourceStatus(r.sources[0]!);expect(JSON.stringify(r)).toBe(before);
});
test('Panda candidate respects source cooldown before suggesting a refresh',()=>{
 const r=report();r.binding.binding.pandaTournamentId='77';
 r.sources=[{provider:'pandascore',sourceKey:'pandascore:roster:77',status:'unavailable',reason:'cooldown',observation:null,fetchedAt:null}];
 expect(roleCandidateStatus(r,player,{...candidate,source:'pandascore',reason:'SOURCE_NOT_FRESH'})).toContain('Подождите');
});
