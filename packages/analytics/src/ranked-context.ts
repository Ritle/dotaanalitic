type CoreMap={matchId:string;accountId:string;heroId:string;startedAt:string;completedAt:string;side:'radiant'|'dire';win:boolean};
/** Deterministic bounded context selection; never a new statistical denominator. */
export function selectRankedContextMaps<T extends CoreMap>(maps:readonly T[]):T[]{
 if(new Set(maps.map(m=>m.matchId)).size!==maps.length)throw Error('duplicate_ranked_map');
 return [...maps].sort((a,b)=>b.startedAt.localeCompare(a.startedAt)||(BigInt(a.matchId)<BigInt(b.matchId)?-1:1)).slice(0,20);
}
export function rankedContextConflict(parent:CoreMap,source:CoreMap):string|null{
 if(parent.matchId!==source.matchId)return 'map_mismatch';
 if(parent.accountId!==source.accountId)return 'account_mismatch';
 if(parent.heroId!==source.heroId)return 'hero_mismatch';
 if(parent.side!==source.side)return 'side_mismatch';
 if(parent.win!==source.win)return 'outcome_conflict';
 if(parent.startedAt!==source.startedAt||parent.completedAt!==source.completedAt)return 'time_mismatch';
 return null;
}
