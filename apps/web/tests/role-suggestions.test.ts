import {expect,test} from 'vitest';
import {arrangeSuggestedRoles,moveRoleDraft} from '../src/role-suggestions';
import type {RoleSuggestionReport} from '@dota/contracts';
const lineup=Array.from({length:5},(_,i)=>({rolePos:i+1,playerId:String(i+1),isStandin:i===0}));
const report={players:lineup.map((p,i)=>({playerId:p.playerId,suggestedRole:5-i}))} as RoleSuggestionReport;
test('reorders players, keeps stand-in with the player, and never mutates manual input',()=>{
  const r=arrangeSuggestedRoles(lineup,report)!;expect(r.map(p=>p.playerId)).toEqual(['5','4','3','2','1']);
  expect(r[4]!.isStandin).toBe(true);expect(lineup[0]!.playerId).toBe('1');
});
test('unknown/colliding/stale suggestions cannot assign leftover positions',()=>{
  for(const players of [report.players.map(p=>({...p,suggestedRole:1})),report.players.map(p=>({...p,suggestedRole:null})),report.players.slice(1)])
    expect(arrangeSuggestedRoles(lineup,{...report,players})).toBeNull();
  expect(arrangeSuggestedRoles(lineup.map((p,i)=>i===0?{...p,playerId:'999'}:p),report)).toBeNull();
});
test('assigned heroes follow players when roles change; opposite side and bans stay intact',()=>{
  const bans=[{teamSlot:'A' as const,heroId:3}];
  const draft={assignments:[{teamSlot:'A' as const,rolePos:1,heroId:1},{teamSlot:'B' as const,rolePos:1,heroId:2}],bans};
  expect(moveRoleDraft(draft,'A',lineup,arrangeSuggestedRoles(lineup,report)!)).toEqual({assignments:[{teamSlot:'A',rolePos:5,heroId:1},{teamSlot:'B',rolePos:1,heroId:2}],bans});
});
