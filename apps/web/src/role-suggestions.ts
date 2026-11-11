import type {DraftInput,RoleSuggestionReport} from '@dota/contracts';
export type RoleMember={rolePos:number;playerId:string|null;isStandin:boolean};
export const roleName=(role:number)=>['','Carry','Mid','Offlane','Semi-support','Hard support'][role]??'Не определена';
/** Swap assignments, keeping each player's card and fields in place. */
export function swapLineupRole<T extends RoleMember>(lineup:readonly T[],from:number,to:number):T[]|null{
  if(lineup.length!==5||new Set(lineup.map(p=>p.rolePos)).size!==5||lineup.some(p=>!Number.isInteger(p.rolePos)||p.rolePos<1||p.rolePos>5)||
    !Number.isInteger(from)||!Number.isInteger(to)||from<1||from>5||to<1||to>5)return null;
  return lineup.map(p=>({...p,rolePos:p.rolePos===from?to:p.rolePos===to?from:p.rolePos}));
}
/** Manual swaps also work with empty slots: null player IDs cannot identify a draft owner. */
export function swapDraftRoles(draft:DraftInput,slot:'A'|'B',from:number,to:number):DraftInput{
  return {...draft,assignments:draft.assignments.map(h=>h.teamSlot!==slot?h:
    {...h,rolePos:h.rolePos===from?to:h.rolePos===to?from:h.rolePos})};
}
export function arrangeSuggestedRoles<T extends RoleMember>(lineup:readonly T[],report:RoleSuggestionReport):T[]|null{
  if(lineup.length!==5||new Set(lineup.map(p=>p.playerId)).size!==5||lineup.some(p=>!p.playerId)||report.players.length!==5)return null;
  const rows=lineup.map(p=>{const r=report.players.find(r=>r.playerId===p.playerId)?.suggestedRole;return r?{...p,rolePos:r}:null;});
  if(rows.some(r=>r===null)||new Set(rows.map(r=>r?.rolePos)).size!==5)return null;
  return rows as T[];
}
/** Canonical wire order is separate from the editable card order. */
export function lineupForRequest<T extends RoleMember>(lineup:readonly T[]):T[]{
  return lineup.map(p=>({...p})).sort((a,b)=>a.rolePos-b.rolePos);
}
/** Preserve the current cards after saving; a different roster gets its own incoming order. */
export function preservePlayerCardOrder<T extends RoleMember>(before:readonly RoleMember[],incoming:readonly T[]):T[]{
  const key=(p:RoleMember)=>p.playerId?`player:${p.playerId}`:`empty:${p.rolePos}`;
  const rows=new Map(incoming.map(p=>[key(p),p]));
  if(before.length!==incoming.length||rows.size!==incoming.length||new Set(before.map(key)).size!==before.length||before.some(p=>!rows.has(key(p))))return incoming.map(p=>({...p}));
  return before.map(p=>({...rows.get(key(p))!}));
}
/** Draft choices belong to players: a new role must retain the player's assigned hero. */
export function moveRoleDraft(draft:DraftInput,slot:'A'|'B',before:readonly RoleMember[],after:readonly RoleMember[]):DraftInput{
  return {...draft,assignments:draft.assignments.map(h=>{
    if(h.teamSlot!==slot)return h;
    const playerId=before.find(p=>p.rolePos===h.rolePos)?.playerId,next=after.find(p=>p.playerId===playerId);
    return next?{...h,rolePos:next.rolePos}:h;
  })};
}
