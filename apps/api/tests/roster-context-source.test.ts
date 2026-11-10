import {createHash} from 'node:crypto';
import {expect,test} from 'vitest';
import {readRosterRegistry} from '../src/modules/catalog/roster-context-source';
const now='2026-11-10T00:00:00.000Z';
const wrap=(players:unknown)=>{const rawBody=JSON.stringify(players);return {rawBody,source:{endpoint:'/proPlayers',fetchedAt:now,payloadSha256:createHash('sha256').update(rawBody).digest('hex')}};};
const player={account_id:1001,steamid:String(76561197960265728n+1001n),name:'Synthetic',team_id:71,team_name:'Synthetic team'};
test('registry source binds exact bytes, endpoint, time, unique numeric accounts and matching Steam64',()=>{
 expect(readRosterRegistry(wrap([player]),now).players[0]!.account_id).toBe('1001');
 expect(readRosterRegistry(wrap([]),now).players).toEqual([]);
 for(const bad of [{...wrap([player]),rawBody:'[]'},wrap([player,player]),wrap([{...player,steamid:'76561197960265728'}]),
  {...wrap([player]),source:{...wrap([player]).source,endpoint:'/search?q=synthetic'}},
  {...wrap([player]),source:{...wrap([player]).source,fetchedAt:'2026-11-11T00:00:00.000Z'}}])expect(()=>readRosterRegistry(bad,now)).toThrow();
});
