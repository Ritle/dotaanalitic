type Source={providerTeamId:string;players:readonly {providerPlayerId:string;selected:boolean;account:{id:string}|null}[]};
export type ReviewedRoster={providerTeamId:string;players:{providerPlayerId:string;accountId:string;rolePos:number}[]};
type Binding={providerTeamId:string;usable:boolean;players:readonly {providerPlayerId:string;accountId:string;playerId:string;identityStatus:string}[]};
export function lineupReviewKey(view:Source|undefined|null){
 return view?JSON.stringify([view.providerTeamId,view.players.filter(p=>p.selected).map(p=>[p.providerPlayerId,p.account?.id??null]).sort((a,b)=>a[0]!.localeCompare(b[0]!))]):'';
}
/** Initial editable slot values, never a claim that a source established these roles. */
export function draftReviewRoles(view:Source|undefined|null):Record<string,number>{
 const selected=view?.players.filter(p=>p.selected)??[];
 return selected.length===5?Object.fromEntries(selected.map((p,i)=>[p.providerPlayerId,i+1])):{};
}
export function reviewedRoster(view:Source|undefined|null,roles:Record<string,number>):ReviewedRoster|null{
 const players=view?.players.filter(p=>p.selected)??[];
 if(!view||players.length!==5||players.some(p=>!p.account)||new Set(players.map(p=>p.account!.id)).size!==5||
  new Set(players.map(p=>p.providerPlayerId)).size!==5||new Set(players.map(p=>roles[p.providerPlayerId])).size!==5||
  players.some(p=>!Number.isInteger(roles[p.providerPlayerId])||roles[p.providerPlayerId]!<1||roles[p.providerPlayerId]!>5))return null;
 return {providerTeamId:view.providerTeamId,players:players.map(p=>({providerPlayerId:p.providerPlayerId,accountId:p.account!.id,rolePos:roles[p.providerPlayerId]!}))};
}
/** Bind expected roles by exact provider-player + Steam32 keys, not response array order. */
export function reviewedBindingLineup(binding:Binding,review:ReviewedRoster){
 if(!binding.usable||binding.providerTeamId!==review.providerTeamId||binding.players.length!==5||review.players.length!==5||
  new Set(review.players.map(p=>p.rolePos)).size!==5||review.players.some(p=>!Number.isInteger(p.rolePos)||p.rolePos<1||p.rolePos>5)||
  new Set(binding.players.map(p=>p.playerId)).size!==5||new Set(binding.players.map(p=>p.accountId)).size!==5||
  new Set(binding.players.map(p=>p.providerPlayerId)).size!==5||new Set(review.players.map(p=>p.accountId)).size!==5||new Set(review.players.map(p=>p.providerPlayerId)).size!==5)return null;
 const mapped=review.players.map(p=>({rolePos:p.rolePos,member:binding.players.find(b=>b.providerPlayerId===p.providerPlayerId&&b.accountId===p.accountId&&b.identityStatus==='verified')}));
 return mapped.some(p=>!p.member)?null:mapped.map(p=>({rolePos:p.rolePos,playerId:p.member!.playerId,isStandin:false}));
}
