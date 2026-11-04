import type {DraftInput,RoleSuggestionReport} from '@dota/contracts';
export type RoleMember={rolePos:number;playerId:string|null;isStandin:boolean};
export const roleName=(role:number)=>['','Керри','Мидер','Офлейнер','Поддержка','Полная поддержка'][role]??'Не определена';
export function arrangeSuggestedRoles<T extends RoleMember>(lineup:readonly T[],report:RoleSuggestionReport):T[]|null{
  if(lineup.length!==5||new Set(lineup.map(p=>p.playerId)).size!==5||lineup.some(p=>!p.playerId)||report.players.length!==5)return null;
  const rows=lineup.map(p=>{const r=report.players.find(r=>r.playerId===p.playerId)?.suggestedRole;return r?{...p,rolePos:r}:null;});
  if(rows.some(r=>r===null)||new Set(rows.map(r=>r?.rolePos)).size!==5)return null;
  return (rows as T[]).sort((a,b)=>a.rolePos-b.rolePos);
}
/** Draft choices belong to players: moving a player must move their assigned hero too. */
export function moveRoleDraft(draft:DraftInput,slot:'A'|'B',before:readonly RoleMember[],after:readonly RoleMember[]):DraftInput{
  return {...draft,assignments:draft.assignments.map(h=>{
    if(h.teamSlot!==slot)return h;
    const playerId=before.find(p=>p.rolePos===h.rolePos)?.playerId,next=after.find(p=>p.playerId===playerId);
    return next?{...h,rolePos:next.rolePos}:h;
  })};
}
