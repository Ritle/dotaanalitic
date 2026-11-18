import {expect,test} from 'vitest';
import {matchingPlayerName,matchingSourceName,type MatchingLabelsReport} from '../src/source-matching-labels';
const id='9007199254740993';
const report=():MatchingLabelsReport=>({binding:{teamId:'1',revision:1,recordedAt:null,binding:{stratzTeamId:'77',pandaTeamId:'88',pandaTournamentId:'55',pandaPlayers:[{playerId:id,providerPlayerId:'2000'}]}},
 players:[{playerId:id,accountIds:['1000'],identityStatus:'verified'}],sources:[{provider:'pandascore',sourceKey:'pandascore:roster:55',status:'ready',reason:null,fetchedAt:'2026-11-11T00:00:00.000Z',
 observation:{provider:'pandascore',sourceKey:'pandascore:roster:55',knownAt:null,eventAt:null,fetchedAt:'2026-11-11T00:00:00.000Z',payloadSha256:'a'.repeat(64),players:[{accountId:null,providerPlayerId:'2000',providerTeamId:'88',name:'Verified source alias',roles:[1]}]}}]});
test('selected catalogue name describes the exact row without changing identity or source data',()=>{
 const r=report();r.players[0]!.identityStatus='conflict';const before=JSON.stringify(r);
 expect(matchingPlayerName(id,' Selected name ',r)).toBe('Selected name');expect(JSON.stringify(r)).toBe(before);expect(r.players[0]!.identityStatus).toBe('conflict');
});
test('fallback uses only a verified numeric provider link and rejects stale, mismatched or ambiguous evidence',()=>{
 const r=report();expect(matchingPlayerName(id,undefined,r)).toBe('Verified source alias');
 r.sources[0]!.status='stale';expect(matchingPlayerName(id,undefined,r)).toBe('Имя недоступно');
 r.sources[0]!.status='ready';r.sources[0]!.observation!.players[0]!.providerPlayerId='2001';expect(matchingPlayerName(id,undefined,r)).toBe('Имя недоступно');
 r.sources[0]!.observation!.players[0]!.providerPlayerId='2000';r.sources[0]!.observation!.players.push({...r.sources[0]!.observation!.players[0]!});expect(matchingPlayerName(id,undefined,r)).toBe('Имя недоступно');
});
test('blank and unavailable names remain distinct; combining marks cannot replace a readable label',()=>{
 expect(matchingPlayerName(id,'   ')).toBe('Игрок без ника');expect(matchingPlayerName(id,undefined)).toBe('Имя недоступно');
 expect(matchingPlayerName(id,String.fromCodePoint(0x20e4,0x20df),report())).toBe('Verified source alias');
});
test('source descriptor binds STRATZ to one verified numeric account, never nickname equality',()=>{
 const r=report(),source={...r.sources[0]!,provider:'stratz' as const,sourceKey:'stratz:player:1000',observation:null};
 expect(matchingSourceName(source,r,{['player:'+id]:'Selected name'})).toBe('Профиль STRATZ: Selected name');
 r.players.push({...r.players[0]!,playerId:'9007199254740994'});expect(matchingSourceName(source,r)).toBe('Профиль игрока STRATZ');
 r.players.pop();r.players[0]!.identityStatus='unknown';expect(matchingSourceName(source,r)).toBe('Профиль игрока STRATZ');
});
test('Panda source describes a roster without inventing team or tournament names',()=>{
 const r=report();expect(matchingSourceName(r.sources[0]!,r)).toBe('Заявка турнира PandaScore');
});
