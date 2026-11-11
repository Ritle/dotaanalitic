import {expect,test} from 'vitest';
import {arrangeSuggestedRoles,moveRoleDraft,swapLineupRole,swapDraftRoles,lineupForRequest,preservePlayerCardOrder} from '../src/role-suggestions';
import type {RoleSuggestionReport} from '@dota/contracts';
const lineup=Array.from({length:5},(_,i)=>({rolePos:i+1,playerId:String(i+1),isStandin:i===0}));
const report={players:lineup.map((p,i)=>({playerId:p.playerId,suggestedRole:5-i}))} as RoleSuggestionReport;
test('assigns roles without reordering player cards, keeps stand-in with the player, and never mutates manual input',()=>{
  const r=arrangeSuggestedRoles(lineup,report)!;expect(r.map(p=>p.playerId)).toEqual(['1','2','3','4','5']);expect(r.map(p=>p.rolePos)).toEqual([5,4,3,2,1]);
  expect(r[0]!.isStandin).toBe(true);expect(lineup[0]!.playerId).toBe('1');
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

test('manual role selection preserves the five positions, player identities, stand-ins and hero ownership',()=>{
 for(let from=1;from<=5;from++)for(let to=1;to<=5;to++){
  const result=swapLineupRole(lineup,from,to)!;
  expect(result.map(p=>p.rolePos).sort()).toEqual([1,2,3,4,5]);expect(result.map(p=>p.playerId)).toEqual(lineup.map(p=>p.playerId));
  expect(result[from-1]!.rolePos).toBe(to);
  expect(result.find(p=>p.playerId==='1')!.isStandin).toBe(true);
  const d={assignments:[{teamSlot:'A' as const,rolePos:from,heroId:1}],bans:[]};
  expect(moveRoleDraft(d,'A',lineup,result).assignments[0]!.rolePos).toBe(to);
 }
 expect(lineup.map(p=>p.playerId)).toEqual(['1','2','3','4','5']);
 expect(swapLineupRole(lineup,1,1)).toEqual(lineup);
 for(const invalid of [0,6,1.5,NaN])expect(swapLineupRole(lineup,1,invalid)).toBeNull();
 expect(swapLineupRole(lineup.slice(1),1,2)).toBeNull();
 expect(swapLineupRole(lineup.map(p=>({...p,rolePos:1})),1,2)).toBeNull();
});

test('manual swaps preserve heroes even when several lineup positions have no player yet',()=>{
 const incomplete=lineup.map(p=>({...p,playerId:p.rolePos===1?'1':null}));
 const draft={assignments:[{teamSlot:'A' as const,rolePos:1,heroId:1},{teamSlot:'A' as const,rolePos:3,heroId:2},{teamSlot:'B' as const,rolePos:1,heroId:3}],bans:[]};
 const after=swapLineupRole(incomplete,1,3)!;
 expect(after[0]!.playerId).toBe('1');expect(after[0]!.rolePos).toBe(3);expect(after[2]!.playerId).toBeNull();
 const moved=swapDraftRoles(draft,'A',1,3);
 expect(moved.assignments).toEqual([{teamSlot:'A',rolePos:3,heroId:1},{teamSlot:'A',rolePos:1,heroId:2},{teamSlot:'B',rolePos:1,heroId:3}]);
 expect(swapDraftRoles(moved,'A',3,1)).toEqual(draft);
});

test('canonical request order never mutates cards; save responses retain their player order',()=>{
 const cards=swapLineupRole(lineup,1,5)!,wire=lineupForRequest(cards);
 expect(wire.map(p=>p.rolePos)).toEqual([1,2,3,4,5]);
 expect(cards.map(p=>p.playerId)).toEqual(['1','2','3','4','5']);expect(cards[0]!.rolePos).toBe(5);
 expect(preservePlayerCardOrder(cards,wire)).toEqual(cards);
 wire[0]!.isStandin=true;expect(cards[4]!.isStandin).toBe(false);
 const incomplete=cards.map((p,i)=>({...p,playerId:i===0?p.playerId:null}));
 expect(preservePlayerCardOrder(incomplete,lineupForRequest(incomplete))).toEqual(incomplete);
});

test('another roster or duplicate identity cannot borrow previous card positions',()=>{
 const changed=lineupForRequest(swapLineupRole(lineup,1,5)!).map((p,i)=>i===0?{...p,playerId:'999'}:p);
 expect(preservePlayerCardOrder(lineup,changed)).toEqual(changed);
 const duplicate=lineup.map(p=>({...p,playerId:'1'}));
 expect(preservePlayerCardOrder(duplicate,lineup)).toEqual(lineup);
});
